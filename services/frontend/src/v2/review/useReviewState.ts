// Review screen state: fetches captures, maps them to rows (mapCaptures.ts),
// and drives the operator's decisions back to the server.
//
// Under v2 every decision is a real save. A capture carries its own review, so
// adopt/exclude and the quality/task overrides all go through the same
// compare-and-swap endpoint (useReviewSave.ts) rather than living in a session
// overlay that the next reload forgets. The local state left here is only what
// IS local: the filters, the selection, and the in-flight optimistic value that
// is reverted the moment a save is refused.
//
// Two v1 concepts are gone with their endpoints. "Export ready" moved
// recordings into a dataset directory; §6 abolished the directory, so dataset
// membership is now the Datasets screen's job. And "archive" here was an
// internal name for Exclude — a review label, never a deletion — while
// `POST /captures/{id}/archive` is a real archive that copies bytes out and
// removes the source. Keeping the old name next to the new endpoint would be
// the most dangerous kind of familiar.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../../api/client';
import { listAllCaptures } from '../../api/captures';
import { listBatches } from '../../api/batches';
import { queryKeys } from '../../api/queryKeys';
import type {
  BatchListResponse,
  Capture,
  Quality,
  RetentionInfo,
  ReviewStatus,
  TaskResult,
} from '../../api/types';
import { useUiStore } from '../../store/uiStore';
import { useCaptureDeletion } from '../captures/useCaptureDeletion';
import { mapCapturesToEpisodes, type BatchSeqLookup } from './mapCaptures';
import { initialTransferSlot, transferReducer } from './transfer';
import { setSplitMode, useSplitMode } from '../captures/splitMode';
import { useReviewSave, type ReviewSaveState } from './useReviewSave';
import { episodeLabel } from './types';
import type {
  DecoratedEpisode,
  Decision,
  DisplayQuality,
  DisplayTaskResult,
  EpisodeRow,
  ReviewLane,
  TransferSlot,
} from './types';

/** Review's own fetch scope: one sweep of everything reviewable, a different
 *  shape from any per-page list, so it gets its own cache entry. */
const REVIEW_SCOPE = 'review';

const QUALITY_ORDER: DisplayQuality[] = ['Good', 'Needs review', 'Not usable'];

// Default work-queue order: NEEDS CHECK first (the exceptions), then READY,
// then EXCLUDED.
const LANE_ORDER: Record<ReviewLane, number> = {
  needs_check: 0,
  ready: 1,
  excluded: 2,
};

// ---- display vocabulary -> the server enums the API takes ------------------
function toServerQuality(q: DisplayQuality): Quality {
  if (q === 'Needs review') return 'needs_review';
  if (q === 'Not usable') return 'not_usable';
  return 'good';
}
function toServerTask(t: DisplayTaskResult): TaskResult {
  return t === 'Failure' ? 'failure' : 'success';
}
function toServerReview(d: Decision): ReviewStatus {
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

  rows: DecoratedEpisode[];
  /** Count of NEEDS CHECK exceptions — the operator's work queue. */
  nNeedsCheck: number;
  hasExcluded: boolean;
  nExcluded: number;
  showExcluded: boolean;
  toggleExcluded: () => void;

  search: string;
  setSearch: (v: string) => void;
  operatorFilter: string;
  setOperatorFilter: (v: string) => void;
  operatorOptions: string[];
  clearFilters: () => void;

  // ---- batch filter + batch-level bulk decisions --------------------------
  batchFilter: string | null;
  batchFilterLabel: string | null;
  toggleBatchFilter: (batchId: string | null) => void;
  batchExcludable: DecoratedEpisode[];
  batchExcluded: DecoratedEpisode[];
  requestExcludeBatch: () => void;
  excludeBatchOpen: boolean;
  excludeBatchRunning: boolean;
  excludeBatchDone: number;
  excludeBatchFailures: { captureId: string; error: string }[];
  confirmExcludeBatch: () => void;
  cancelExcludeBatch: () => void;
  returnBatchToReview: () => void;

  selectedCaptureId: string | null;
  select: (captureId: string) => void;
  selected: DecoratedEpisode | undefined;

  /** Exclude / restore one capture. Reversible — a review label, not a
   *  deletion; the recording stays exactly where it is. */
  requestExclude: (captureId: string) => void;
  /** True while the exclude confirmation is open. Deliberately not derived
   *  from the episode number: a capture with no `index_in_batch` has none, and
   *  gating the dialog on it left that capture unable to be excluded at all. */
  excludePending: boolean;
  /** The episode label for the confirmation's title ("#3" or "—"). */
  pendingExcludeLabel: string | null;
  confirmExclude: () => void;
  cancelExclude: () => void;

  // ---- removal (§7): two separate intents, never one control -------------
  /** Excluded captures — the set the bulk controls act on. */
  excludedRows: DecoratedEpisode[];
  /** "Discard (not uploaded)": irreversible, reason required. */
  requestDiscard: (captureIds: string[]) => void;
  /** "Delete": the ordinary removal. */
  requestDelete: (captureIds: string[]) => void;
  deletion: ReturnType<typeof useCaptureDeletion>;

  /** Resolve a NEEDS CHECK exception into READY (server: adopted). */
  markOk: () => void;
  decide: (d: Decision) => void;
  cycleFinalQuality: () => void;
  cycleTaskResult: () => void;
  /** Save state: the conflict banner and the explicit failure notice. */
  reviewSave: ReviewSaveState;

  goMonitor: () => void;
  goValidation: () => void;

  // ---- retention (advisory only; it never deletes) -----------------------
  retentionDays: number;
  retentionCandidateCount: number;
  retentionTotalBytes: number;
  retentionFilterActive: boolean;
  showRetentionBanner: boolean;
  applyRetentionFilter: () => void;
  clearRetentionFilter: () => void;
  dismissRetentionBanner: () => void;

  splitMode: boolean;
  nAwaiting: number;
  transferOne: (captureId: string) => void;
  transferAllAwaiting: () => void;

  toast: string;
}

export function useReviewState(): ReviewState {
  const queryClient = useQueryClient();
  const capturesQuery = useQuery({
    queryKey: queryKeys.captureList(REVIEW_SCOPE),
    // Follow the cursor to exhaustion: the lane counts and the bulk sets must
    // cover EVERY reviewable capture, and a single page silently drops the tail
    // once the catalog outgrows it.
    queryFn: ({ signal }) => listAllCaptures({}, signal),
  });

  // Batch numbers for the row labels. A separate, best-effort read: the batch
  // is display metadata, so a failure costs a "—" in one column rather than
  // the screen.
  const batchesQuery = useQuery({
    queryKey: queryKeys.batches,
    queryFn: ({ signal }) => listBatches({}, signal),
  });
  const batchSeq: BatchSeqLookup = useMemo(() => {
    const byId = new Map<string, { seq: number | null; createdAt: string | null }>();
    for (const b of (batchesQuery.data as BatchListResponse | undefined)?.items ?? []) {
      byId.set(b.batch_id, { seq: b.batch_seq ?? null, createdAt: b.created_at ?? null });
    }
    return (batchId) => (batchId ? (byId.get(batchId) ?? null) : null);
  }, [batchesQuery.data]);

  // Advisory retention candidates. Best-effort: a failure hides the banner and
  // never blocks Review.
  const retentionQuery = useQuery({
    queryKey: queryKeys.retention,
    queryFn: ({ signal }) => apiGet<RetentionInfo>('/retention', { signal }),
  });
  const retention = retentionQuery.data;

  // ---- split mode: derived from the server's transfer channel -------------
  // The importer sidecar (the robot->PC pull channel) answers its healthz only
  // on a split recording-PC deploy, so `available` IS "this is a split
  // deployment". Read once per session so a test/e2e override is not clobbered
  // by a later refetch; on error the default (off) stands honestly.
  const splitMode = useSplitMode();
  const transferStatusQuery = useQuery({
    queryKey: queryKeys.transferStatus,
    queryFn: ({ signal }) =>
      apiGet<{ available?: boolean }>('/transfer/status', { signal }),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const transferAvailable = transferStatusQuery.data?.available;
  useEffect(() => {
    if (typeof transferAvailable === 'boolean') setSplitMode(transferAvailable);
  }, [transferAvailable]);

  const isError = capturesQuery.isError;
  const errorMessage =
    capturesQuery.error instanceof Error ? capturesQuery.error.message : null;
  const baseEpisodes: EpisodeRow[] = useMemo(
    // On error the table shows an honest empty/error state, never a fabricated
    // dataset.
    () =>
      capturesQuery.data
        ? mapCapturesToEpisodes(capturesQuery.data.items, batchSeq)
        : [],
    [capturesQuery.data, batchSeq],
  );

  // ---- toast --------------------------------------------------------------
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

  const reviewSave = useReviewSave(REVIEW_SCOPE);

  // ---- optimistic overlay -------------------------------------------------
  // The ONLY local state over the server's values: what the operator just
  // clicked, held until the save lands. A refused save deletes the entry, so
  // the row snaps back to what is actually stored — the screen never keeps
  // showing a value the server rejected.
  const [pending, setPending] = useState<
    Record<
      string,
      { quality?: DisplayQuality; task?: DisplayTaskResult; status?: ReviewStatus }
    >
  >({});
  const [transfers, setTransfers] = useState<Record<string, TransferSlot>>({});

  const clearPending = useCallback((captureId: string) => {
    setPending((cur) => {
      if (!(captureId in cur)) return cur;
      const next = { ...cur };
      delete next[captureId];
      return next;
    });
  }, []);

  const decorated: DecoratedEpisode[] = useMemo(
    () =>
      baseEpisodes.map((e) => {
        const p = pending[e.captureId];
        const effectiveReviewStatus = p?.status ?? e.reviewStatus;
        const effectiveQuality = p?.quality ?? e.quality;
        const isExcluded = effectiveReviewStatus === 'excluded';
        // Exception-review lane: READY by default when the recording is good or
        // the operator confirmed it; NEEDS CHECK is the exception queue (not
        // good AND still pending); EXCLUDED is set aside.
        const reviewLane: ReviewLane = isExcluded
          ? 'excluded'
          : effectiveQuality === 'Good' || effectiveReviewStatus === 'adopted'
            ? 'ready'
            : 'needs_check';
        return {
          ...e,
          effectiveQuality,
          effectiveTask: p?.task ?? e.task,
          isExcluded,
          decision: null,
          effectiveReviewStatus,
          reviewLane,
          transferSlot: transfers[e.captureId] ?? initialTransferSlot(e.transfer),
        };
      }),
    [baseEpisodes, pending, transfers],
  );

  // ---- filters / search ---------------------------------------------------
  const [showExcluded, setShowExcluded] = useState(false);
  const toggleExcluded = useCallback(() => setShowExcluded((v) => !v), []);
  const [search, setSearch] = useState('');
  const [operatorFilter, setOperatorFilter] = useState<string>(ALL_OPERATORS);
  const [batchFilter, setBatchFilter] = useState<string | null>(null);
  const toggleBatchFilter = useCallback((batchId: string | null) => {
    setBatchFilter((cur) => (batchId === null || cur === batchId ? null : batchId));
  }, []);

  // ---- retention (advisory) ----------------------------------------------
  const [retentionFilterActive, setRetentionFilterActive] = useState(false);
  const [retentionBannerDismissed, setRetentionBannerDismissed] = useState(false);
  const retentionCandidateIds = useMemo(() => {
    const ids = new Set<string>();
    for (const c of retention?.candidates ?? []) ids.add(c.capture_id);
    return ids;
  }, [retention]);
  const retentionDays = retention?.days ?? 0;
  const retentionCandidateCount = retention?.candidates?.length ?? 0;
  const retentionTotalBytes = retention?.total_bytes ?? 0;
  const applyRetentionFilter = useCallback(() => setRetentionFilterActive(true), []);
  const clearRetentionFilter = useCallback(() => setRetentionFilterActive(false), []);
  const dismissRetentionBanner = useCallback(
    () => setRetentionBannerDismissed(true),
    [],
  );
  // Show when there are candidates and the window is on; stay visible while the
  // filter is active (even if dismissed) so "Show all" is always reachable.
  const showRetentionBanner =
    retentionDays > 0 &&
    retentionCandidateCount > 0 &&
    (!retentionBannerDismissed || retentionFilterActive);

  const clearFilters = useCallback(() => {
    setSearch('');
    setOperatorFilter(ALL_OPERATORS);
    setBatchFilter(null);
    setRetentionFilterActive(false);
  }, []);

  const operatorOptions = useMemo(() => {
    const set = new Set<string>();
    for (const e of baseEpisodes) if (e.operator) set.add(e.operator);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [baseEpisodes]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return decorated
      .filter((r) => showExcluded || !r.isExcluded)
      .filter((r) => operatorFilter === ALL_OPERATORS || r.operator === operatorFilter)
      .filter((r) => !batchFilter || r.batchId === batchFilter)
      .filter((r) => !retentionFilterActive || retentionCandidateIds.has(r.captureId))
      .filter((r) => {
        if (!q) return true;
        // Every on-screen identity is searchable: the operator reads run_id,
        // a capture_id pasted from a log or a URL must find its row, and the
        // operator NAME the row displays must match too (typing "ux-audit"
        // returned "0 shown" while the Operator column said exactly that —
        // audit P2).
        return (
          // Only a real number is searchable; an unnumbered row must not be
          // findable by typing "null".
          (r.ep !== null && `#${r.ep}`.includes(q)) ||
          r.captureId.toLowerCase().includes(q) ||
          (r.runId?.toLowerCase().includes(q) ?? false) ||
          (r.operator?.toLowerCase().includes(q) ?? false)
        );
      })
      // Lane first (the work queue), then newest recording first WITHIN a lane.
      // Deliberately NOT by `ep`: that is index_in_batch, which restarts at 1
      // in every batch, so ordering by it interleaves two batches into a
      // meaningless 3,2,2,1,1. started_at is a global ordering; capture_id is
      // the tiebreak because UUIDv7 is time-ordered, so it agrees with it.
      .sort((a, b) => {
        const lane = LANE_ORDER[a.reviewLane] - LANE_ORDER[b.reviewLane];
        if (lane !== 0) return lane;
        const ta = a.startedAt ? Date.parse(a.startedAt) : NaN;
        const tb = b.startedAt ? Date.parse(b.startedAt) : NaN;
        if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb) return tb - ta;
        return b.captureId.localeCompare(a.captureId);
      });
  }, [
    decorated,
    search,
    operatorFilter,
    batchFilter,
    showExcluded,
    retentionFilterActive,
    retentionCandidateIds,
  ]);

  const nExcluded = useMemo(
    () => decorated.filter((r) => r.isExcluded).length,
    [decorated],
  );
  const nNeedsCheck = useMemo(
    () => decorated.filter((r) => r.reviewLane === 'needs_check').length,
    [decorated],
  );

  // ---- selection ----------------------------------------------------------
  const [selectedCaptureId, setSelectedCaptureId] = useState<string | null>(null);
  const select = useCallback((captureId: string) => setSelectedCaptureId(captureId), []);
  useEffect(() => {
    if (selectedCaptureId || decorated.length === 0) return;
    // Same global newest-first order as the table sort above — `ep` is
    // batch-scoped and would auto-select an older batch's row mid-table.
    const sorted = [...decorated].sort((a, b) => {
      const ta = a.startedAt ? Date.parse(a.startedAt) : NaN;
      const tb = b.startedAt ? Date.parse(b.startedAt) : NaN;
      if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb) return tb - ta;
      return b.captureId.localeCompare(a.captureId);
    });
    const first = sorted.find((r) => !r.isExcluded) ?? sorted[0];
    if (first) setSelectedCaptureId(first.captureId);
  }, [decorated, selectedCaptureId]);
  const selected = decorated.find((r) => r.captureId === selectedCaptureId);

  /** Apply one review change optimistically, then save. A refusal drops the
   *  overlay entry so the row returns to the stored value. */
  const applyReview = useCallback(
    async (
      row: DecoratedEpisode,
      overlay: { quality?: DisplayQuality; task?: DisplayTaskResult; status?: ReviewStatus },
      changes: Parameters<ReviewSaveState['save']>[1],
      options?: Parameters<ReviewSaveState['save']>[2],
    ) => {
      setPending((cur) => ({ ...cur, [row.captureId]: { ...cur[row.captureId], ...overlay } }));
      const result = await reviewSave.save(row.capture, changes, options);
      clearPending(row.captureId);
      return result;
    },
    [reviewSave, clearPending],
  );

  // ---- exclude / restore (a review label; the recording is untouched) -----
  const [pendingExcludeId, setPendingExcludeId] = useState<string | null>(null);
  const requestExclude = useCallback(
    (captureId: string) => {
      const row = decorated.find((r) => r.captureId === captureId);
      if (!row) return;
      if (row.isExcluded) {
        void applyReview(row, { status: 'pending' }, { review_status: 'pending' }).then(
          ({ capture }) => {
            if (capture)
              showToast(`Episode ${episodeLabel(row.ep)} restored — no longer excluded`);
          },
        );
        return;
      }
      setPendingExcludeId(captureId);
    },
    [decorated, applyReview, showToast],
  );
  const confirmExclude = useCallback(() => {
    if (!pendingExcludeId) return;
    const row = decorated.find((r) => r.captureId === pendingExcludeId);
    setPendingExcludeId(null);
    if (!row) return;
    void applyReview(
      row,
      { status: 'excluded', quality: 'Not usable' },
      {
        review_status: 'excluded',
        quality: 'not_usable',
        quality_source: 'operator',
      },
    ).then(({ capture }) => {
      if (capture) {
        showToast(
          `Episode ${episodeLabel(row.ep)} → Not usable · Excluded (recording kept, restorable)`,
        );
      }
    });
  }, [pendingExcludeId, decorated, applyReview, showToast]);
  const cancelExclude = useCallback(() => setPendingExcludeId(null), []);
  const pendingExcludeLabel = pendingExcludeId
    ? episodeLabel(decorated.find((r) => r.captureId === pendingExcludeId)?.ep ?? null)
    : null;

  // ---- removal (§7) -------------------------------------------------------
  // Both intents run through the one shared flow, so the wording, the required
  // reason and the error handling cannot drift apart between screens.
  const excludedRows = useMemo(
    () => decorated.filter((r) => r.isExcluded),
    [decorated],
  );
  const deletion = useCaptureDeletion({
    invalidate: [queryKeys.captureList(REVIEW_SCOPE), queryKeys.retention],
    onDeleted: (ids) => {
      for (const id of ids) clearPending(id);
      setSelectedCaptureId((cur) => (cur && ids.includes(cur) ? null : cur));
    },
    onToast: showToast,
  });
  const capturesById = useMemo(() => {
    const byId = new Map<string, Capture>();
    for (const row of decorated) byId.set(row.captureId, row.capture);
    return byId;
  }, [decorated]);
  const resolveTargets = useCallback(
    (ids: string[]) =>
      ids.map((id) => capturesById.get(id)).filter((c): c is Capture => !!c),
    [capturesById],
  );
  const requestDiscard = useCallback(
    (ids: string[]) => deletion.requestDiscard(resolveTargets(ids)),
    [deletion, resolveTargets],
  );
  const requestDelete = useCallback(
    (ids: string[]) => deletion.requestDelete(resolveTargets(ids)),
    [deletion, resolveTargets],
  );

  // ---- batch-level bulk decisions ----------------------------------------
  // The enforcement arm of per-batch validation: a batch that failed its check
  // must be one action away from staying out of the ready set. Same semantics
  // as the single-row Exclude — the recordings are KEPT and it is reversible.
  const batchRows = useMemo(
    () => (batchFilter ? decorated.filter((r) => r.batchId === batchFilter) : []),
    [decorated, batchFilter],
  );
  const batchFilterLabel = batchFilter ? (batchRows[0]?.batch ?? batchFilter) : null;
  const batchExcludable = useMemo(
    () => batchRows.filter((r) => r.effectiveReviewStatus !== 'excluded'),
    [batchRows],
  );
  const batchExcluded = useMemo(
    () => batchRows.filter((r) => r.effectiveReviewStatus === 'excluded'),
    [batchRows],
  );

  const [excludeBatchOpen, setExcludeBatchOpen] = useState(false);
  const [excludeBatchRunning, setExcludeBatchRunning] = useState(false);
  const [excludeBatchDone, setExcludeBatchDone] = useState(0);
  const [excludeBatchFailures, setExcludeBatchFailures] = useState<
    { captureId: string; error: string }[]
  >([]);
  const requestExcludeBatch = useCallback(() => {
    setExcludeBatchFailures([]);
    setExcludeBatchDone(0);
    setExcludeBatchOpen(true);
  }, []);
  const cancelExcludeBatch = useCallback(() => {
    if (excludeBatchRunning) return;
    setExcludeBatchOpen(false);
    setExcludeBatchFailures([]);
    setExcludeBatchDone(0);
  }, [excludeBatchRunning]);
  const confirmExcludeBatch = useCallback(() => {
    const targets = batchExcludable;
    if (!targets.length) {
      setExcludeBatchOpen(false);
      return;
    }
    setExcludeBatchRunning(true);
    setExcludeBatchDone(0);
    setExcludeBatchFailures([]);
    void (async () => {
      const failures: { captureId: string; error: string }[] = [];
      let succeeded = 0;
      for (const t of targets) {
        const { capture, error } = await applyReview(
          t,
          { status: 'excluded', quality: 'Not usable' },
          {
            review_status: 'excluded',
            quality: 'not_usable',
            quality_source: 'operator',
          },
          // One sweep at the end, not one per capture.
          { skipInvalidate: true },
        );
        if (capture) succeeded += 1;
        else {
          // Reported by id and NOT dropped: a capture that stayed in the ready
          // set because its save failed is exactly what the operator needs to
          // know before trusting the batch. The message comes from THIS save's
          // result — reading it off the hook's banner state would report
          // whichever failure happened to land there last.
          failures.push({
            captureId: t.captureId,
            error: error ? `${error.message} ${error.guidance}`.trim() : 'save failed',
          });
        }
        setExcludeBatchDone((d) => d + 1);
        setExcludeBatchFailures([...failures]);
      }
      await reviewSave.invalidateList();
      setExcludeBatchRunning(false);
      if (failures.length === 0) {
        showToast(
          `Excluded ${succeeded} episode${succeeded === 1 ? '' : 's'} — recordings kept, reversible`,
        );
        setExcludeBatchOpen(false);
      } else {
        showToast(`Excluded ${succeeded}, ${failures.length} failed`);
      }
    })();
  }, [batchExcludable, applyReview, reviewSave, showToast]);

  const returnBatchToReview = useCallback(() => {
    const targets = batchExcluded;
    if (!targets.length) return;
    void (async () => {
      let restored = 0;
      for (const t of targets) {
        const { capture } = await applyReview(
          t,
          { status: 'pending' },
          { review_status: 'pending' },
          { skipInvalidate: true },
        );
        if (capture) restored += 1;
      }
      await reviewSave.invalidateList();
      showToast(`Returned ${restored} episode${restored === 1 ? '' : 's'} to review`);
    })();
  }, [batchExcluded, applyReview, reviewSave, showToast]);

  // ---- decisions / overrides ---------------------------------------------
  const decide = useCallback(
    (d: Decision) => {
      if (!selected) return;
      void applyReview(
        selected,
        { status: toServerReview(d) },
        { review_status: toServerReview(d) },
      ).then(({ capture }) => {
        if (capture) showToast(`Episode ${episodeLabel(selected.ep)} → ${d}`);
      });
    },
    [selected, applyReview, showToast],
  );

  // Adopt this capture — the one thing Datasets requires before a capture can
  // join a training set. It reads two ways depending on where the operator is:
  // "Mark OK — include" resolves a NEEDS CHECK exception, while on a READY
  // capture it is simply the adoption. One server effect either way.
  const markOk = useCallback(() => {
    if (!selected) return;
    const exception = selected.reviewLane === 'needs_check';
    void applyReview(selected, { status: 'adopted' }, { review_status: 'adopted' }).then(
      ({ capture }) => {
        if (capture) {
          showToast(
            exception
              ? `Episode ${episodeLabel(selected.ep)} marked OK — included`
              : `Episode ${episodeLabel(selected.ep)} adopted — datasets can use it`,
          );
        }
      },
    );
  }, [selected, applyReview, showToast]);

  const cycleFinalQuality = useCallback(() => {
    if (!selected) return;
    // From an unset ("—") base, indexOf === -1 → the first click lands on Good.
    const idx = selected.effectiveQuality
      ? QUALITY_ORDER.indexOf(selected.effectiveQuality)
      : -1;
    const next = QUALITY_ORDER[(idx + 1) % QUALITY_ORDER.length]!;
    void applyReview(
      selected,
      { quality: next },
      { quality: toServerQuality(next), quality_source: 'operator' },
    ).then(({ capture }) => {
      if (capture) showToast(`${episodeLabel(selected.ep)} quality → ${next}`);
    });
  }, [selected, applyReview, showToast]);

  const cycleTaskResult = useCallback(() => {
    if (!selected) return;
    // Unset base → the first click sets Success; thereafter it toggles.
    const next: DisplayTaskResult =
      selected.effectiveTask === 'Success' ? 'Failure' : 'Success';
    void applyReview(selected, { task: next }, { task_result: toServerTask(next) }).then(
      ({ capture }) => {
        if (capture) showToast(`${episodeLabel(selected.ep)} task result → ${next}`);
      },
    );
  }, [selected, applyReview, showToast]);

  // ---- deep links ---------------------------------------------------------
  const setActiveTab = useUiStore((s) => s.setActiveTab);
  const setPendingRun = useUiStore((s) => s.setPendingRun);
  const goMonitor = useCallback(() => {
    if (selected) setPendingRun(selected.captureId);
    setActiveTab('monitor');
  }, [selected, setActiveTab, setPendingRun]);
  const goValidation = useCallback(() => {
    if (selected) setPendingRun(selected.captureId);
    setActiveTab('validation');
  }, [selected, setActiveTab, setPendingRun]);

  // ---- transfer (split mode) ---------------------------------------------
  // Real channel: POST /transfer/pull queues an rsync pull on the importer
  // sidecar (202 ack, fire-and-forget). Completion is observed through the
  // capture's replica appearing — there is no progress to report, so none is
  // invented.
  const failTransfer = useCallback(
    (captureIds: string[], message: string) => {
      setTransfers((prev) => {
        const next = { ...prev };
        for (const id of captureIds) {
          const cur = next[id];
          if (cur) next[id] = transferReducer(cur, { type: 'FAIL' });
        }
        return next;
      });
      showToast(message);
    },
    [showToast],
  );

  const transferOne = useCallback(
    (captureId: string) => {
      const seedRow = baseEpisodes.find((e) => e.captureId === captureId);
      setTransfers((prev) => {
        const cur = prev[captureId] ?? initialTransferSlot(seedRow?.transfer ?? 'awaiting');
        if (cur.phase !== 'awaiting') return prev;
        return { ...prev, [captureId]: transferReducer(cur, { type: 'START' }) };
      });
      apiPost('/transfer/pull', { capture_id: captureId }).catch((err: unknown) => {
        failTransfer(
          [captureId],
          err instanceof Error
            ? `Transfer couldn't start — ${err.message}`
            : "Transfer couldn't start",
        );
      });
    },
    [baseEpisodes, failTransfer],
  );

  // Completion + reconcile: whenever the server reports a local copy but the
  // session slot still says transferring, finalize it. This also covers pulls
  // we did not start here (auto_pull_on_save, a manual import run).
  useEffect(() => {
    const doneIds = baseEpisodes
      .filter(
        (e) => e.transfer === 'here' && transfers[e.captureId]?.phase === 'transferring',
      )
      .map((e) => e.captureId);
    if (!doneIds.length) return;
    setTransfers((prev) => {
      const next = { ...prev };
      for (const id of doneIds) next[id] = transferReducer(next[id]!, { type: 'DONE' });
      return next;
    });
    showToast(
      doneIds.length === 1
        ? 'Episode transferred to the recording PC'
        : `${doneIds.length} episodes transferred to the recording PC`,
    );
  }, [baseEpisodes, transfers, showToast]);

  // While any transfer is in flight, poll so an arriving replica is seen within
  // a few seconds. An rsync of a long episode takes minutes, and the slot
  // honestly stays "transferring" until the server confirms.
  const anyTransferring = useMemo(
    () => Object.values(transfers).some((s) => s.phase === 'transferring'),
    [transfers],
  );
  useEffect(() => {
    if (!anyTransferring) return;
    const timer = setInterval(() => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.captureList(REVIEW_SCOPE),
      });
    }, 4000);
    return () => clearInterval(timer);
  }, [anyTransferring, queryClient]);

  const nAwaiting = useMemo(
    () =>
      decorated.filter((r) => !r.isExcluded && r.transferSlot.phase === 'awaiting')
        .length,
    [decorated],
  );
  const transferAllAwaiting = useCallback(() => {
    const targets = decorated.filter(
      (r) => !r.isExcluded && r.transferSlot.phase === 'awaiting',
    );
    if (!targets.length) {
      showToast('Nothing to transfer');
      return;
    }
    targets.forEach((r) => transferOne(r.captureId));
    showToast(
      `Transferring ${targets.length} episode${targets.length === 1 ? '' : 's'}…`,
    );
  }, [decorated, transferOne, showToast]);

  return {
    isLoading: capturesQuery.isPending,
    isError,
    errorMessage,

    rows,
    nNeedsCheck,
    hasExcluded: nExcluded > 0,
    nExcluded,
    showExcluded,
    toggleExcluded,

    search,
    setSearch,
    operatorFilter,
    setOperatorFilter,
    operatorOptions,
    clearFilters,

    batchFilter,
    batchFilterLabel,
    toggleBatchFilter,
    batchExcludable,
    batchExcluded,
    requestExcludeBatch,
    excludeBatchOpen,
    excludeBatchRunning,
    excludeBatchDone,
    excludeBatchFailures,
    confirmExcludeBatch,
    cancelExcludeBatch,
    returnBatchToReview,

    selectedCaptureId,
    select,
    selected,

    requestExclude,
    excludePending: pendingExcludeId !== null,
    pendingExcludeLabel,
    confirmExclude,
    cancelExclude,

    excludedRows,
    requestDiscard,
    requestDelete,
    deletion,

    markOk,
    decide,
    cycleFinalQuality,
    cycleTaskResult,
    reviewSave,

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
    nAwaiting,
    transferOne,
    transferAllAwaiting,

    toast,
  };
}
