// Review screen state: fetches real runs, maps them to episodes (mapRuns.ts),
// and layers the locally-decided state on top — decisions, quality/task
// overrides, archival, transfer, selection, and the toast. None of this posts
// back to the orchestrator (there's no Session/Batch/Episode-review backend
// model yet — Phase 2, mirroring the Collect screen's useBatchMachine.ts note
// on the same gap). The REAL per-run inspection (detail rows, video, loss,
// validation, JSON sidecars) lives in RunInspection.tsx, which fetches
// GET /runs/{id} and drives the real dora_runner job flows.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiGet, apiPost } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type {
  DatasetExportSummary,
  EpisodePatchRequest,
  EpisodeQuality,
  EpisodeReviewStatus,
  EpisodeTaskResult,
  Page,
  RetentionInfo,
  RunSummary,
} from '../../api/types';
import { useUiStore } from '../../store/uiStore';
import { patchEpisode, removeEpisodeOutcome } from '../episodeBridge';
import { mapRunsToEpisodes } from './mapRuns';
import { initialTransferSlot, transferReducer, TRANSFER_DURATION_MS, TRANSFER_TICK_MS } from './transfer';
import { useSplitMode } from './splitMode';
import type {
  Decision,
  DecoratedEpisode,
  EpisodeRow,
  Quality,
  ReviewLane,
  ReviewStatus,
  TaskResult,
  TransferSlot,
} from './types';

// Own query key (not queryKeys.runs(cursor)): this screen wants one big page
// of everything reviewable, a different shape than the Recordings list's
// cursor-paginated fetch, so it doesn't share that cache entry.
const REVIEW_RUNS_KEY = ['runs', 'review-list'] as const;
const REVIEW_PAGE_LIMIT = 200;

const QUALITY_ORDER: Quality[] = ['Good', 'Needs review', 'Not usable'];

// Default work-queue order: NEEDS CHECK first (exceptions), then READY, EXCLUDED.
const LANE_ORDER: Record<ReviewLane, number> = { needs_check: 0, ready: 1, excluded: 2 };

// ---- Review display value → Phase 2 server enum (for PATCH /episodes) ------
function toServerQuality(q: Quality): EpisodeQuality {
  if (q === 'Needs review') return 'needs_review';
  if (q === 'Not usable') return 'not_usable';
  return 'good';
}
function toServerTask(t: TaskResult): EpisodeTaskResult {
  return t === 'Failure' ? 'failure' : 'success';
}
function toServerReview(d: Decision): EpisodeReviewStatus {
  if (d === 'adopted') return 'adopted';
  if (d === 'excluded') return 'excluded';
  return 'pending';
}

/** Sentinel option value for "any operator" in the operator filter. */
export const ALL_OPERATORS = '__all__';

export interface ReviewState {
  isLoading: boolean;
  isError: boolean;
  errorMessage: string | null;

  rows: DecoratedEpisode[]; // visible (NEEDS CHECK → READY → EXCLUDED, newest-first)
  /** Count of NEEDS CHECK exceptions — the operator's work queue. */
  nNeedsCheck: number;
  hasArchived: boolean;
  nArchived: number;
  showArchived: boolean;
  toggleArchived: () => void;

  search: string;
  setSearch: (v: string) => void;
  operatorFilter: string;
  setOperatorFilter: (v: string) => void;
  operatorOptions: string[];
  clearFilters: () => void;

  selectedRunId: string | null;
  select: (runId: string) => void;
  selected: DecoratedEpisode | undefined;
  /** Count of the operator's own quality/task overrides on the selected run
   *  this session — the real "override history" the detail panel surfaces. */
  selectedOverrideCount: number;

  requestArchive: (runId: string) => void;
  pendingArchiveEp: number | null;
  confirmArchive: () => void;
  cancelArchive: () => void;

  // ---- physical delete (two-step: only on Excluded episodes) --------------
  /** The excluded episodes eligible for permanent deletion (kept on disk). */
  excludedRows: DecoratedEpisode[];
  /** Single delete: open the confirm for one excluded run. */
  requestDelete: (runId: string) => void;
  pendingDeleteRow: DecoratedEpisode | null;
  deleting: boolean;
  deleteError: string | null;
  confirmDelete: () => void;
  cancelDelete: () => void;
  /** Bulk delete of every excluded episode. */
  requestBulkDelete: () => void;
  bulkDeleteOpen: boolean;
  bulkRunning: boolean;
  bulkDone: number;
  bulkFailures: { runId: string; error: string }[];
  confirmBulkDelete: () => void;
  cancelBulkDelete: () => void;

  // ---- export READY → Datasets (exception-review, one click) --------------
  /** READY AND 'completed' — the runs "Export ready (n)" will actually move
   *  (respects the include-failed toggle). */
  readyExportable: DecoratedEpisode[];
  /** READY but not 'completed' — listed as skipped (with the reason). */
  readySkipped: DecoratedEpisode[];
  /** Include labeled task-failures in the export set (default true). */
  includeFailed: boolean;
  setIncludeFailed: (v: boolean) => void;
  requestExportReady: () => void;
  exportReadyOpen: boolean;
  exportRunning: boolean;
  exportDone: number;
  exportFailures: { runId: string; error: string }[];
  confirmExportReady: () => void;
  cancelExportReady: () => void;

  /** Resolve a NEEDS CHECK exception into READY (server: review_status adopted). */
  markOk: () => void;
  decide: (d: Decision) => void;
  cycleFinalQuality: () => void;
  cycleTaskResult: () => void;

  goMonitor: () => void;
  goValidation: () => void;

  // ---- retention (advisory: surface old, un-exported recordings) ----------
  // A read-only nudge for the operator to reclaim disk. It NEVER deletes: the
  // banner applies a filter over the existing rows; deletion still goes through
  // the confirmed Exclude -> Delete flow above.
  /** Active RETENTION_DAYS window (0 = feature off, banner never shows). */
  retentionDays: number;
  /** How many loaded runs are old-and-unexported candidates. */
  retentionCandidateCount: number;
  /** Combined best-effort size of those candidates (bytes). */
  retentionTotalBytes: number;
  /** Whether the table is currently filtered to the retention candidates. */
  retentionFilterActive: boolean;
  /** Whether to render the advisory banner (candidates exist + not dismissed,
   *  or the filter is active so there's always a way back to "show all"). */
  showRetentionBanner: boolean;
  /** Filter the table down to the retention candidates (banner CTA). */
  applyRetentionFilter: () => void;
  /** Leave the retention-only view (show every row again). */
  clearRetentionFilter: () => void;
  /** Dismiss the advisory banner for this session (no state changed). */
  dismissRetentionBanner: () => void;

  splitMode: boolean;
  nUntransferred: number;
  transferOne: (runId: string) => void;
  transferAllUntransferred: () => void;

  toast: string;
}

export function useReviewState(): ReviewState {
  const queryClient = useQueryClient();
  const runsQuery = useQuery({
    queryKey: REVIEW_RUNS_KEY,
    // Follow the cursor to exhaustion: Review's counts, lanes, and the
    // "Export ready (n)" set must cover EVERY reviewable run — a single
    // 200-row page silently dropped the tail once the system grew past it
    // (persona review R2 / codex). Pages stay at 200 per request; the guard
    // caps runaway pagination at 50 pages (10k runs) and reports honestly.
    queryFn: async ({ signal }) => {
      const items: RunSummary[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 50; page++) {
        const res = await apiGet<Page<RunSummary>>('/runs', {
          signal,
          query: { limit: REVIEW_PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
        });
        items.push(...res.items);
        if (!res.next_cursor) return { items, next_cursor: null };
        cursor = res.next_cursor;
      }
      return { items, next_cursor: cursor ?? null };
    },
  });
  // Advisory retention candidates (old, un-exported recordings). A separate,
  // best-effort read: a failure just hides the banner (never blocks Review).
  const retentionQuery = useQuery({
    queryKey: queryKeys.retention,
    queryFn: ({ signal }) => apiGet<RetentionInfo>('/retention', { signal }),
  });
  const retention = retentionQuery.data;

  const isError = runsQuery.isError;
  const errorMessage = runsQuery.error instanceof Error ? runsQuery.error.message : null;
  const baseEpisodes: EpisodeRow[] = useMemo(
    // On error we show an honest empty/error state (EpisodeTable), never a
    // fabricated demo dataset.
    () => (runsQuery.data ? mapRunsToEpisodes(runsQuery.data.items) : []),
    [runsQuery.data],
  );

  // ---- toast ----------------------------------------------------------------
  const [toast, setToast] = useState('');
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(''), 2400);
  }, []);
  useEffect(
    () => () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    },
    [],
  );

  // ---- Phase 2 server sync (PATCH /episodes) --------------------------------
  // Adopt/exclude and quality/result overrides are applied optimistically to the
  // local overlays below, then PATCHed to the server episode when the run has
  // one. A run WITHOUT a server episode (bridge-only / pre-Phase-2) stays
  // local-only — nothing to sync. On a failed PATCH we revert the optimistic
  // change and say so, so the UI never claims a server-save that didn't happen.
  const syncEpisode = useCallback(
    (episodeId: string | null, body: EpisodePatchRequest, revert: () => void) => {
      if (!episodeId) return;
      patchEpisode(episodeId, body)
        .then(() => {
          void queryClient.invalidateQueries({ queryKey: REVIEW_RUNS_KEY });
        })
        .catch(() => {
          revert();
          showToast('Couldn’t save to the server — change reverted');
        });
    },
    [queryClient, showToast],
  );

  // ---- local overlays: decisions / overrides / archive / transfer ----------
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [overrides, setOverrides] = useState<Record<string, { quality?: Quality; task?: TaskResult }>>({});
  // Per-run count of the operator's own override actions this session — real
  // local history behind the detail panel's "override history" caption.
  const [overrideCounts, setOverrideCounts] = useState<Record<string, number>>({});
  const [archivedRunIds, setArchivedRunIds] = useState<Record<string, true>>({});
  const [transfers, setTransfers] = useState<Record<string, TransferSlot>>({});

  // Restore a map entry to a captured prior value (delete when it had none) —
  // used by the optimistic PATCH reverts below.
  const restoreOverride = useCallback(
    (runId: string, prev: { quality?: Quality; task?: TaskResult } | undefined) => {
      setOverrides((cur) => {
        const next = { ...cur };
        if (prev === undefined) delete next[runId];
        else next[runId] = prev;
        return next;
      });
    },
    [],
  );
  const restoreDecision = useCallback((runId: string, prev: Decision | undefined) => {
    setDecisions((cur) => {
      const next = { ...cur };
      if (prev === undefined) delete next[runId];
      else next[runId] = prev;
      return next;
    });
  }, []);

  const decorated: DecoratedEpisode[] = useMemo(
    () =>
      baseEpisodes.map((e) => {
        const ov = overrides[e.runId];
        const isArchived = !!archivedRunIds[e.runId];
        const decision = decisions[e.runId] ?? null;
        // The status chip: a session decision wins, then the server episode's
        // review_status, then 'pending'. ('review' = keep-in-review = pending.)
        const effectiveReviewStatus: ReviewStatus =
          isArchived || decision === 'excluded'
            ? 'excluded'
            : decision === 'adopted'
              ? 'adopted'
              : decision === 'review'
                ? 'pending'
                : (e.reviewStatus ?? 'pending');
        const effectiveQuality = ov?.quality ?? e.quality;
        // Exception-review lane: READY by default when the recording is good or
        // the operator confirmed it; NEEDS CHECK is the exception queue (not
        // good AND still pending); EXCLUDED is set aside.
        const reviewLane: ReviewLane =
          effectiveReviewStatus === 'excluded'
            ? 'excluded'
            : effectiveQuality === 'Good' || effectiveReviewStatus === 'adopted'
              ? 'ready'
              : 'needs_check';
        return {
          ...e,
          effectiveQuality,
          effectiveTask: ov?.task ?? e.task,
          isArchived,
          decision,
          effectiveReviewStatus,
          reviewLane,
          transferSlot: transfers[e.runId] ?? initialTransferSlot(e.transfer),
        };
      }),
    [baseEpisodes, overrides, archivedRunIds, decisions, transfers],
  );

  // ---- filters / search -----------------------------------------------------
  const [showArchived, setShowArchived] = useState(false);
  const toggleArchived = useCallback(() => setShowArchived((v) => !v), []);
  const [search, setSearch] = useState('');
  const [operatorFilter, setOperatorFilter] = useState<string>(ALL_OPERATORS);

  // ---- retention (advisory) -----------------------------------------------
  const [retentionFilterActive, setRetentionFilterActive] = useState(false);
  const [retentionBannerDismissed, setRetentionBannerDismissed] = useState(false);
  const retentionCandidateRunIds = useMemo(() => {
    const ids = new Set<string>();
    for (const c of retention?.candidates ?? []) ids.add(c.run_id);
    return ids;
  }, [retention]);
  const retentionDays = retention?.days ?? 0;
  const retentionCandidateCount = retention?.candidates?.length ?? 0;
  const retentionTotalBytes = retention?.total_bytes ?? 0;
  const applyRetentionFilter = useCallback(() => setRetentionFilterActive(true), []);
  const clearRetentionFilter = useCallback(() => setRetentionFilterActive(false), []);
  const dismissRetentionBanner = useCallback(() => setRetentionBannerDismissed(true), []);
  // Show when there are candidates and the window is on; stay visible while the
  // filter is active (even if dismissed) so "Show all" is always reachable.
  const showRetentionBanner =
    retentionDays > 0 &&
    retentionCandidateCount > 0 &&
    (!retentionBannerDismissed || retentionFilterActive);

  const clearFilters = useCallback(() => {
    setSearch('');
    setOperatorFilter(ALL_OPERATORS);
    setRetentionFilterActive(false);
  }, []);

  // Distinct real operators across the loaded runs — the one filter with a real
  // backing (RunSummary.operator); others in FiltersRail stay display-only.
  const operatorOptions = useMemo(() => {
    const set = new Set<string>();
    for (const e of baseEpisodes) if (e.operator) set.add(e.operator);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [baseEpisodes]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return decorated
      .filter((r) => showArchived || !r.isArchived)
      .filter((r) => operatorFilter === ALL_OPERATORS || r.operator === operatorFilter)
      .filter((r) => !retentionFilterActive || retentionCandidateRunIds.has(r.runId))
      .filter((r) => {
        if (!q) return true;
        return `#${r.ep}`.toLowerCase().includes(q) || r.runId.toLowerCase().includes(q);
      })
      .sort((a, b) => LANE_ORDER[a.reviewLane] - LANE_ORDER[b.reviewLane] || b.ep - a.ep);
  }, [decorated, search, operatorFilter, showArchived, retentionFilterActive, retentionCandidateRunIds]);

  const nArchived = useMemo(() => decorated.filter((r) => r.isArchived).length, [decorated]);
  const nNeedsCheck = useMemo(
    () => decorated.filter((r) => r.reviewLane === 'needs_check').length,
    [decorated],
  );

  // ---- selection --------------------------------------------------------
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const select = useCallback((runId: string) => setSelectedRunId(runId), []);
  useEffect(() => {
    if (selectedRunId || decorated.length === 0) return;
    const sorted = [...decorated].sort((a, b) => b.ep - a.ep);
    const first = sorted.find((r) => !r.isArchived) ?? sorted[0];
    if (first) setSelectedRunId(first.runId);
  }, [decorated, selectedRunId]);
  const selected = decorated.find((r) => r.runId === selectedRunId);
  const selectedOverrideCount = selectedRunId ? (overrideCounts[selectedRunId] ?? 0) : 0;

  // ---- archive (with confirm) ------------------------------------------
  // "Archive" is this file's internal name for what the UI presents as
  // "Exclude" — non-destructive (persona test P3: the mock's own "delete
  // candidate" wording read as actual deletion and scared operators away from
  // the control). Nothing here ever removes a recording; it only reclassifies
  // quality/decision and hides the row from the default view. Every surface
  // (tooltip, modal, toast) says so explicitly.
  const [pendingArchiveRunId, setPendingArchiveRunId] = useState<string | null>(null);
  const requestArchive = useCallback(
    (runId: string) => {
      const row = decorated.find((r) => r.runId === runId);
      if (!row) return;
      if (row.isArchived) {
        setArchivedRunIds((prev) => {
          const next = { ...prev };
          delete next[runId];
          return next;
        });
        showToast(`Episode #${row.ep} restored — no longer excluded`);
        // Un-exclude on the server → review_status pending; re-hide on failure.
        syncEpisode(row.episodeId, { review_status: 'pending' }, () => {
          setArchivedRunIds((prev) => ({ ...prev, [runId]: true }));
        });
        return;
      }
      setPendingArchiveRunId(runId);
    },
    [decorated, showToast, syncEpisode],
  );
  const confirmArchive = useCallback(() => {
    if (!pendingArchiveRunId) return;
    const runId = pendingArchiveRunId;
    const row = decorated.find((r) => r.runId === runId);
    const prevOverride = overrides[runId];
    const prevDecision = decisions[runId];
    setArchivedRunIds((prev) => ({ ...prev, [runId]: true }));
    setOverrides((prev) => ({
      ...prev,
      [runId]: { ...prev[runId], quality: 'Not usable' },
    }));
    setDecisions((prev) => ({ ...prev, [runId]: 'excluded' }));
    showToast(`Episode #${row?.ep ?? '?'} → Not usable · Excluded (recording kept, restorable)`);
    setPendingArchiveRunId(null);
    // Exclude on the server; revert the whole optimistic change if it fails.
    syncEpisode(
      row?.episodeId ?? null,
      { review_status: 'excluded', quality: 'not_usable', quality_source: 'operator' },
      () => {
        setArchivedRunIds((prev) => {
          const next = { ...prev };
          delete next[runId];
          return next;
        });
        restoreOverride(runId, prevOverride);
        restoreDecision(runId, prevDecision);
      },
    );
  }, [pendingArchiveRunId, decorated, overrides, decisions, showToast, syncEpisode, restoreOverride, restoreDecision]);
  const cancelArchive = useCallback(() => setPendingArchiveRunId(null), []);
  const pendingArchiveEp = pendingArchiveRunId
    ? (decorated.find((r) => r.runId === pendingArchiveRunId)?.ep ?? null)
    : null;

  // ---- physical delete (storage reclamation) ------------------------------
  // Two-step, and only reachable on an already-Excluded episode: Exclude is a
  // reversible review label (the recording stays on disk); Delete is the
  // permanent DELETE /api/v1/runs/{id}. Purge all local overlay state for a
  // gone run so nothing stale lingers, and drop the selection if it was the
  // deleted one (the auto-select effect then picks the next episode).
  const excludedRows = useMemo(() => decorated.filter((r) => r.isArchived), [decorated]);
  const purgeLocal = useCallback((runId: string) => {
    const drop = <T,>(prev: Record<string, T>) => {
      if (!(runId in prev)) return prev;
      const next = { ...prev };
      delete next[runId];
      return next;
    };
    setArchivedRunIds(drop);
    setDecisions(drop);
    setOverrides(drop);
    setTransfers(drop);
    setOverrideCounts(drop);
    setSelectedRunId((cur) => (cur === runId ? null : cur));
    // A deleted run is gone for good — drop its Collect->Review bridge entry too.
    removeEpisodeOutcome(runId);
  }, []);

  const [pendingDeleteRunId, setPendingDeleteRunId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const requestDelete = useCallback((runId: string) => {
    setDeleteError(null);
    setPendingDeleteRunId(runId);
  }, []);
  const cancelDelete = useCallback(() => {
    if (deleting) return;
    setPendingDeleteRunId(null);
    setDeleteError(null);
  }, [deleting]);
  const confirmDelete = useCallback(async () => {
    if (!pendingDeleteRunId) return;
    const runId = pendingDeleteRunId;
    const row = decorated.find((r) => r.runId === runId);
    setDeleting(true);
    setDeleteError(null);
    try {
      await apiDelete(`/runs/${encodeURIComponent(runId)}`);
      purgeLocal(runId);
      await queryClient.invalidateQueries({ queryKey: REVIEW_RUNS_KEY });
      showToast(`Episode #${row?.ep ?? '?'} deleted from disk`);
      setPendingDeleteRunId(null);
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setDeleting(false);
    }
  }, [pendingDeleteRunId, decorated, purgeLocal, queryClient, showToast]);
  const pendingDeleteRow = pendingDeleteRunId
    ? (decorated.find((r) => r.runId === pendingDeleteRunId) ?? null)
    : null;

  // Bulk delete every excluded episode: sequential DELETEs with live progress,
  // honestly reporting per-run failures (a failed run stays excluded, not
  // silently dropped).
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkDone, setBulkDone] = useState(0);
  const [bulkFailures, setBulkFailures] = useState<{ runId: string; error: string }[]>([]);
  const requestBulkDelete = useCallback(() => {
    setBulkFailures([]);
    setBulkDone(0);
    setBulkDeleteOpen(true);
  }, []);
  const cancelBulkDelete = useCallback(() => {
    if (bulkRunning) return;
    setBulkDeleteOpen(false);
    setBulkFailures([]);
    setBulkDone(0);
  }, [bulkRunning]);
  const confirmBulkDelete = useCallback(async () => {
    const targets = decorated.filter((r) => r.isArchived);
    if (!targets.length) {
      setBulkDeleteOpen(false);
      return;
    }
    setBulkRunning(true);
    setBulkDone(0);
    setBulkFailures([]);
    const failures: { runId: string; error: string }[] = [];
    const succeeded: string[] = [];
    for (const t of targets) {
      try {
        await apiDelete(`/runs/${encodeURIComponent(t.runId)}`);
        succeeded.push(t.runId);
      } catch (e) {
        failures.push({ runId: t.runId, error: e instanceof Error ? e.message : 'failed' });
      }
      setBulkDone((d) => d + 1);
      setBulkFailures([...failures]);
    }
    succeeded.forEach(purgeLocal);
    await queryClient.invalidateQueries({ queryKey: REVIEW_RUNS_KEY });
    setBulkRunning(false);
    if (failures.length === 0) {
      showToast(`Deleted ${succeeded.length} excluded episode${succeeded.length === 1 ? '' : 's'} from disk`);
      setBulkDeleteOpen(false);
    } else {
      // Keep the modal open so the per-run failures stay visible.
      showToast(`Deleted ${succeeded.length}, ${failures.length} failed`);
    }
  }, [decorated, purgeLocal, queryClient, showToast]);

  // ---- export READY → Datasets (exception-review: no per-item adopt) --------
  // READY episodes export with zero clicks (good quality, or the operator
  // confirmed an exception). "Include task-failed (labeled)" defaults ON — a
  // labeled failure is still useful data; OFF drops task_result==='failure' from
  // the set. Only 'completed' runs move; a READY run not yet completed is
  // skipped. Sequential POST /datasets/export, live progress + honest failures,
  // then the same MOVE invalidation (review list + runs + datasets).
  const [includeFailed, setIncludeFailed] = useState(true);
  const readyRows = useMemo(() => decorated.filter((r) => r.reviewLane === 'ready'), [decorated]);
  const readyExportable = useMemo(
    () =>
      readyRows.filter(
        (r) => r.state === 'completed' && (includeFailed || r.effectiveTask !== 'Failure'),
      ),
    [readyRows, includeFailed],
  );
  const readySkipped = useMemo(
    () => readyRows.filter((r) => r.state !== 'completed'),
    [readyRows],
  );
  const [exportReadyOpen, setExportReadyOpen] = useState(false);
  const [exportRunning, setExportRunning] = useState(false);
  const [exportDone, setExportDone] = useState(0);
  const [exportFailures, setExportFailures] = useState<{ runId: string; error: string }[]>([]);
  const requestExportReady = useCallback(() => {
    setExportFailures([]);
    setExportDone(0);
    setExportReadyOpen(true);
  }, []);
  const cancelExportReady = useCallback(() => {
    if (exportRunning) return;
    setExportReadyOpen(false);
    setExportFailures([]);
    setExportDone(0);
  }, [exportRunning]);
  const confirmExportReady = useCallback(async () => {
    const targets = readyExportable;
    if (!targets.length) {
      setExportReadyOpen(false);
      return;
    }
    setExportRunning(true);
    setExportDone(0);
    setExportFailures([]);
    const failures: { runId: string; error: string }[] = [];
    const succeeded: string[] = [];
    for (const t of targets) {
      try {
        await apiPost<DatasetExportSummary>('/datasets/export', { run_id: t.runId });
        succeeded.push(t.runId);
      } catch (e) {
        failures.push({ runId: t.runId, error: e instanceof Error ? e.message : 'failed' });
      }
      setExportDone((d) => d + 1);
      setExportFailures([...failures]);
    }
    succeeded.forEach(purgeLocal);
    // MOVE: exported runs leave Review + Recordings and appear under Datasets.
    await queryClient.invalidateQueries({ queryKey: REVIEW_RUNS_KEY });
    await queryClient.invalidateQueries({ queryKey: queryKeys.runs(undefined) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.datasets });
    setExportRunning(false);
    if (failures.length === 0) {
      showToast(
        `Exported ${succeeded.length} ready episode${succeeded.length === 1 ? '' : 's'} to Datasets`,
      );
      setExportReadyOpen(false);
    } else {
      showToast(`Exported ${succeeded.length}, ${failures.length} failed`);
    }
  }, [readyExportable, purgeLocal, queryClient, showToast]);

  // ---- decisions / overrides ---------------------------------------------
  const decide = useCallback(
    (d: Decision) => {
      if (!selected) return;
      const runId = selected.runId;
      const prev = decisions[runId];
      setDecisions((prevD) => ({ ...prevD, [runId]: d }));
      showToast(`Episode #${selected.ep} → ${d}`);
      syncEpisode(selected.episodeId, { review_status: toServerReview(d) }, () =>
        restoreDecision(runId, prev),
      );
    },
    [selected, decisions, showToast, syncEpisode, restoreDecision],
  );

  // "Mark OK — include": resolve a NEEDS CHECK exception into READY. Same server
  // effect as an adopt (review_status:'adopted'), but the operator vocabulary is
  // "include", not "adopt" — good episodes are already READY without any click.
  const markOk = useCallback(() => {
    if (!selected) return;
    const runId = selected.runId;
    const prev = decisions[runId];
    setDecisions((prevD) => ({ ...prevD, [runId]: 'adopted' }));
    showToast(`Episode #${selected.ep} marked OK — included in the export`);
    syncEpisode(selected.episodeId, { review_status: 'adopted' }, () => restoreDecision(runId, prev));
  }, [selected, decisions, showToast, syncEpisode, restoreDecision]);

  const bumpOverrideCount = useCallback((runId: string) => {
    setOverrideCounts((prev) => ({ ...prev, [runId]: (prev[runId] ?? 0) + 1 }));
  }, []);

  const cycleFinalQuality = useCallback(() => {
    if (!selected) return;
    const runId = selected.runId;
    const episodeId = selected.episodeId;
    // From an unset ("—") base, indexOf === -1 → first click lands on "Good".
    const idx = selected.effectiveQuality ? QUALITY_ORDER.indexOf(selected.effectiveQuality) : -1;
    const next = QUALITY_ORDER[(idx + 1) % QUALITY_ORDER.length]!;
    const prevOverride = overrides[runId];
    setOverrides((prev) => ({ ...prev, [runId]: { ...prev[runId], quality: next } }));
    bumpOverrideCount(runId);
    showToast(`#${selected.ep} quality → ${next} (your override, kept this session)`);
    syncEpisode(episodeId, { quality: toServerQuality(next), quality_source: 'operator' }, () => {
      restoreOverride(runId, prevOverride);
      setOverrideCounts((prev) => ({ ...prev, [runId]: Math.max(0, (prev[runId] ?? 1) - 1) }));
    });
  }, [selected, overrides, showToast, bumpOverrideCount, syncEpisode, restoreOverride]);

  const cycleTaskResult = useCallback(() => {
    if (!selected) return;
    const runId = selected.runId;
    const episodeId = selected.episodeId;
    // Unset base → first click sets Success; thereafter toggles.
    const next: TaskResult = selected.effectiveTask === 'Success' ? 'Failure' : 'Success';
    const prevOverride = overrides[runId];
    setOverrides((prev) => ({ ...prev, [runId]: { ...prev[runId], task: next } }));
    bumpOverrideCount(runId);
    showToast(`#${selected.ep} task result → ${next} (your override, kept this session)`);
    syncEpisode(episodeId, { task_result: toServerTask(next) }, () => {
      restoreOverride(runId, prevOverride);
      setOverrideCounts((prev) => ({ ...prev, [runId]: Math.max(0, (prev[runId] ?? 1) - 1) }));
    });
  }, [selected, overrides, showToast, bumpOverrideCount, syncEpisode, restoreOverride]);

  // ---- deep links ---------------------------------------------------------
  const setActiveTab = useUiStore((s) => s.setActiveTab);
  const setPendingRun = useUiStore((s) => s.setPendingRun);
  const goMonitor = useCallback(() => {
    if (selected) setPendingRun(selected.runId);
    setActiveTab('monitor');
  }, [selected, setActiveTab, setPendingRun]);
  const goValidation = useCallback(() => {
    if (selected) setPendingRun(selected.runId);
    setActiveTab('validation');
  }, [selected, setActiveTab, setPendingRun]);

  // ---- transfer (split mode) ---------------------------------------------
  const splitMode = useSplitMode();
  const transferTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  useEffect(
    () => () => {
      Object.values(transferTimers.current).forEach(clearTimeout);
    },
    [],
  );
  const transferOne = useCallback(
    (runId: string) => {
      setTransfers((prev) => {
        const seedRow = baseEpisodes.find((e) => e.runId === runId);
        const cur = prev[runId] ?? initialTransferSlot(seedRow?.transfer ?? 'on_robot');
        if (cur.phase !== 'on_robot') return prev;
        return { ...prev, [runId]: transferReducer(cur, { type: 'START' }) };
      });
      const start = Date.now();
      const tick = () => {
        setTransfers((prev) => {
          const cur = prev[runId];
          if (!cur || cur.phase !== 'transferring') return prev;
          const elapsed = Date.now() - start;
          if (elapsed >= TRANSFER_DURATION_MS) {
            delete transferTimers.current[runId];
            showToast('Episode transferred to the recording PC');
            return { ...prev, [runId]: transferReducer(cur, { type: 'DONE' }) };
          }
          transferTimers.current[runId] = setTimeout(tick, TRANSFER_TICK_MS);
          return {
            ...prev,
            [runId]: transferReducer(cur, { type: 'TICK', pct: Math.round((elapsed / TRANSFER_DURATION_MS) * 100) }),
          };
        });
      };
      transferTimers.current[runId] = setTimeout(tick, TRANSFER_TICK_MS);
    },
    [baseEpisodes, showToast],
  );
  const nUntransferred = useMemo(
    () => decorated.filter((r) => !r.isArchived && r.transferSlot.phase === 'on_robot').length,
    [decorated],
  );
  const transferAllUntransferred = useCallback(() => {
    const targets = decorated.filter((r) => !r.isArchived && r.transferSlot.phase === 'on_robot');
    if (!targets.length) {
      showToast('Nothing to transfer');
      return;
    }
    targets.forEach((r) => transferOne(r.runId));
    showToast(`Transferring ${targets.length} episode${targets.length === 1 ? '' : 's'}…`);
  }, [decorated, transferOne, showToast]);

  return {
    isLoading: runsQuery.isPending,
    isError,
    errorMessage,

    rows,
    nNeedsCheck,
    hasArchived: nArchived > 0,
    nArchived,
    showArchived,
    toggleArchived,

    search,
    setSearch,
    operatorFilter,
    setOperatorFilter,
    operatorOptions,
    clearFilters,

    selectedRunId,
    select,
    selected,
    selectedOverrideCount,

    requestArchive,
    pendingArchiveEp,
    confirmArchive,
    cancelArchive,

    excludedRows,
    requestDelete,
    pendingDeleteRow,
    deleting,
    deleteError,
    confirmDelete,
    cancelDelete,
    requestBulkDelete,
    bulkDeleteOpen,
    bulkRunning,
    bulkDone,
    bulkFailures,
    confirmBulkDelete,
    cancelBulkDelete,

    readyExportable,
    readySkipped,
    includeFailed,
    setIncludeFailed,
    requestExportReady,
    exportReadyOpen,
    exportRunning,
    exportDone,
    exportFailures,
    confirmExportReady,
    cancelExportReady,

    markOk,
    decide,
    cycleFinalQuality,
    cycleTaskResult,

    goMonitor,
    goValidation,

    retentionDays,
    retentionCandidateCount,
    retentionTotalBytes,
    retentionFilterActive,
    showRetentionBanner,
    applyRetentionFilter,
    clearRetentionFilter,
    dismissRetentionBanner,

    splitMode,
    nUntransferred,
    transferOne,
    transferAllUntransferred,

    toast,
  };
}
