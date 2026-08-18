// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
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

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { listAllCaptures } from '../../api/captures';
import { getRetention } from '../../api/system';
import { getPullStatus, pullCapture } from '../../api/transfer';
import { listBatches } from '../../api/batches';
import { queryKeys } from '../../api/queryKeys';
import { TRANSFER_PROGRESS_POLL_MS } from '../pollingPolicy';
import type {
  BatchListResponse,
  CaptureListItem,
  Quality,
  QualitySource,
  ReviewStatus,
  TaskResult,
} from '../../api/types';
import { useUiStore } from '../../store/uiStore';
import { useCaptureDeletion } from '../captures/useCaptureDeletion';
import { useBulkRun } from '../shared/useBulkRun';
import { displayQuality } from '../episodeChips';
import { mapCapturesToEpisodes, type BatchSeqLookup } from './mapCaptures';
import { initialTransferSlot, transferReducer } from './transfer';
import { setSplitMode, useSplitMode } from '../captures/splitMode';
import { useTransferAvailable } from '../captures/useSplitDeploy';
import type { CaptureErrorReading } from '../captures/errors';
import {
  useReviewSave,
  type ReviewSaveResult,
  type ReviewSaveState,
} from './useReviewSave';
import type {
  DecoratedEpisode,
  Decision,
  DisplayQuality,
  DisplayTaskResult,
  EpisodeRow,
  ReviewLane,
  TransferSlot,
} from './types';
import { useToast } from '../shared/useToast';

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

/** How a capture is named in a message: its episode number when it has one,
 *  then the run id, then the raw id. Module-level and pure so a caller holding
 *  a row can name it without taking a dependency on the hook's render. */
function subjectOf(row: Pick<DecoratedEpisode, 'ep' | 'runId' | 'captureId'>): string {
  if (row.ep != null) return `Episode #${row.ep}`;
  return row.runId ?? row.captureId;
}

/** What an undo put back, in the screen's own vocabulary ("Adopted · Good").
 *  The toast says the state by name rather than "restored": an operator who
 *  mis-clicked needs to see WHICH state came back, not that something did. */
function describePrior(prior: ExcludeUndo['prior']): string {
  const status =
    prior.review_status === 'adopted'
      ? 'Adopted'
      : prior.review_status === 'excluded'
        ? 'Excluded'
        : 'Pending';
  const quality = displayQuality(prior.quality);
  return quality ? `${status} · ${quality}` : status;
}

/** Sentinel option value for "any operator" in the operator filter. */
export const ALL_OPERATORS = '__all__';

/** What an exclude overwrote, so it can be put back exactly.
 *
 *  Excluding writes BOTH `review_status` and `quality` (→ excluded /
 *  not_usable), and Return only ever writes `pending` — so before this, taking
 *  back a mis-click on an adopted capture meant Return, then Adopt, and the
 *  quality it had been carrying was simply gone. The three fields below are the
 *  three the exclude touches, read off the STORED capture rather than the
 *  optimistic overlay, and `quality_source` travels with `quality` because
 *  restoring a validator's verdict as an operator's would put a human's name on
 *  a machine's judgement. */
export interface ExcludeUndo {
  captureId: string;
  /** "Episode #3" / the run id — resolved when the exclude happened, because
   *  the row it names is filtered out of the table the moment it is excluded. */
  subject: string;
  prior: {
    review_status: ReviewStatus;
    quality: Quality | null;
    quality_source: QualitySource | null;
  };
}

export interface ReviewState {
  isLoading: boolean;
  isError: boolean;
  errorMessage: string | null;
  /** True when the capture sweep hit its page cap and stopped short of the end
   *  of the catalog. The rows below — and every tally, lane count and bulk set
   *  taken over them — are then about what was fetched, not about everything
   *  there is, which is a difference the screen has to say out loud (E-27). */
  catalogTruncated: boolean;

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
  /** Members a batch return could not move, by id. The return has no dialog of
   *  its own, so this is what lets the screen name them rather than leaving
   *  "Returned N" to imply the whole set went back. */
  returnBatchFailures: { captureId: string; error: string }[];

  /** How a banner names the capture it is about. A banner outlives the
   *  selection and the filters, so it has to identify its own subject. */
  captureSubject: (captureId: string) => string;

  selectedCaptureId: string | null;
  select: (captureId: string) => void;
  selected: DecoratedEpisode | undefined;

  /** Exclude / restore one capture. Reversible — a review label, not a
   *  deletion; the recording stays exactly where it is. */
  requestExclude: (captureId: string) => void;
  /** The last exclude that can still be taken back, or null. Session-scoped
   *  and client-held by design: the store has no "previous review" to ask for,
   *  and inventing one server-side would make an undo affordance out of a
   *  schema change. Keyed by capture id, never by row identity — the detail
   *  poll replaces row objects underneath a held reference. */
  excludeUndo: ExcludeUndo | null;
  /** Put the remembered {review_status, quality, quality_source} back in one
   *  save. Kept on failure so it can be tried again; cleared only when the
   *  restore actually lands. */
  undoExclude: () => void;
  /** Drop the offer without restoring anything. */
  dismissExcludeUndo: () => void;

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

/** What a bulk run says about a member it stepped over because the operator
 *  had a save of their own still unanswered for it. Reported rather than
 *  counted as done — nothing was written — but it is not "save failed": the
 *  server never refused anything, and saying so would send the operator
 *  looking for a fault that is not there. */
const SKIPPED_BY_OWN_SAVE =
  'Skipped — a change you saved for this episode was still being written, so ' +
  'this did not overwrite it. Run it again.';

const reasonFor = (error: CaptureErrorReading | null) =>
  error ? `${error.message} ${error.guidance}`.trim() : 'save failed';

/** One refused capture in a batch-level run, named so the operator can find it. */
interface BatchFailure {
  captureId: string;
  error: string;
}

const batchFailure = (
  captureId: string,
  error: CaptureErrorReading | null,
  skipped: boolean | undefined,
): BatchFailure => ({
  captureId,
  error: skipped ? SKIPPED_BY_OWN_SAVE : reasonFor(error),
});

export function useReviewState(): ReviewState {
  const queryClient = useQueryClient();
  const capturesQuery = useQuery({
    queryKey: queryKeys.captureList(REVIEW_SCOPE),
    // Follow the cursor to exhaustion: the lane counts and the bulk sets must
    // cover EVERY reviewable capture, and a single page silently drops the tail
    // once the catalog outgrows it.
    queryFn: ({ signal }) => listAllCaptures({}, signal),
  });
  // The sweep stops after MAX_PAGES and returns what it has WITH the unfinished
  // cursor, so a non-null cursor means it never reached the end of the catalog.
  const catalogTruncated = capturesQuery.data?.next_cursor != null;

  // Batch numbers for the row labels. A separate, best-effort read: the batch
  // is display metadata, so a failure costs a "—" in one column rather than
  // the screen.
  const batchesQuery = useQuery({
    queryKey: queryKeys.batches,
    queryFn: ({ signal }) => listBatches({}, signal),
  });
  const batchSeq: BatchSeqLookup = useMemo(() => {
    const byId = new Map<
      string,
      { seq: number | null; createdAt: string | null; condition: string | null }
    >();
    for (const b of (batchesQuery.data as BatchListResponse | undefined)
      ?.items ?? []) {
      byId.set(b.batch_id, {
        seq: b.batch_seq ?? null,
        createdAt: b.created_at ?? null,
        condition: b.condition ?? null,
      });
    }
    return (batchId) => (batchId ? (byId.get(batchId) ?? null) : null);
  }, [batchesQuery.data]);

  // Advisory retention candidates. Best-effort: a failure hides the banner and
  // never blocks Review.
  const retentionQuery = useQuery({
    queryKey: queryKeys.retention,
    queryFn: ({ signal }) => getRetention({ signal }),
  });
  const retention = retentionQuery.data;

  // ---- split mode: derived from the server's transfer channel -------------
  // The shared probe (useSplitDeploy) answers whether this is a split deploy;
  // THIS screen is the one that pushes the answer into the global splitMode
  // store, which the discard dialog reads (§12).
  const splitMode = useSplitMode();
  const transferAvailable = useTransferAvailable();
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
        ? mapCapturesToEpisodes(
            capturesQuery.data.items,
            batchSeq,
            batchesQuery.isPending ? 'loading' : 'unavailable',
          )
        : [],
    [capturesQuery.data, batchSeq, batchesQuery.isPending],
  );

  // ---- toast --------------------------------------------------------------
  const { toast, showToast } = useToast();

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

  // The two batch-level bulk runs (their operations are further down). They are
  // declared up here because the batch FILTER also clears the return notice —
  // see toggleBatchFilter immediately below.
  const excludeBatch = useBulkRun<BatchFailure>();
  const returnBatch = useBulkRun<BatchFailure>();
  const { run: runExcludeBatch, reset: resetExcludeBatch } = excludeBatch;
  const { run: runReturnBatch, reset: resetReturnBatch } = returnBatch;

  // ---- filters / search ---------------------------------------------------
  const [showExcluded, setShowExcluded] = useState(false);
  const toggleExcluded = useCallback(() => setShowExcluded((v) => !v), []);
  const [search, setSearch] = useState('');
  const [operatorFilter, setOperatorFilter] = useState<string>(ALL_OPERATORS);
  const [batchFilter, setBatchFilter] = useState<string | null>(null);
  const toggleBatchFilter = useCallback((batchId: string | null) => {
    // Drop any previous batch's return failures: the notice names a count with
    // no batch on it, so carrying it across a filter change would pin one
    // batch's failure onto another.
    resetReturnBatch();
    setBatchFilter((cur) => (batchId === null || cur === batchId ? null : batchId));
  }, [resetReturnBatch]);

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

  // The episode number when the server issued one, else the run_id, else the
  // capture_id. An id is ugly but it identifies; "Episode —" does not. Reads
  // the UNFILTERED set on purpose: a banner survives a filter change, and
  // naming it after whatever the search box currently admits would make the
  // subject a property of the view rather than of the capture.
  //
  // Deliberately NOT memoised. Nothing depends on its identity, and a
  // `useCallback` here would hold whichever list its dependency array named:
  // a later edit that reads a different list without updating the deps would
  // answer from a stale one, which is the same bug wearing a cache. Read live.
  const captureSubject = (captureId: string) => {
    const row = decorated.find((r) => r.captureId === captureId);
    return row ? subjectOf(row) : captureId;
  };

  /** Apply one review change optimistically, then save. A refusal drops the
   *  overlay entry so the row returns to the stored value. */
  const applyReview = useCallback(
    async (
      row: DecoratedEpisode,
      overlay: { quality?: DisplayQuality; task?: DisplayTaskResult; status?: ReviewStatus },
      changes: Parameters<ReviewSaveState['save']>[1],
      options?: Parameters<ReviewSaveState['save']>[2],
    ): Promise<ReviewSaveResult> => {
      // Return BEFORE touching the overlay. A save for this capture is already
      // on the wire; the overlay below belongs to it, and setting-then-clearing
      // it here would drop that save's optimistic value while it is still
      // unanswered — the row would snap back to the stored value mid-flight.
      if (reviewSave.isSaving(row.captureId))
        return { capture: null, error: null, skipped: true };
      setPending((cur) => ({ ...cur, [row.captureId]: { ...cur[row.captureId], ...overlay } }));
      const result = await reviewSave.save(row.capture, changes, options);
      clearPending(row.captureId);
      return result;
    },
    [reviewSave, clearPending],
  );

  // ---- exclude / restore (a review label; the recording is untouched) -----
  //
  // No confirmation dialog on either entry point, and one shared path for both.
  // Excluding keeps every byte and is now undoable in one action, so a modal in
  // front of it would be a speed bump on the most repeated action of an
  // exception-review pass — and the kind of speed bump that teaches an operator
  // to confirm without reading. The dialogs that remain are the ones guarding
  // something that cannot be taken back: Discard and Delete.
  const [excludeUndo, setExcludeUndo] = useState<ExcludeUndo | null>(null);
  const dismissExcludeUndo = useCallback(() => setExcludeUndo(null), []);

  /** Exclude one capture, remembering what it overwrote. */
  const excludeCapture = useCallback(
    (row: DecoratedEpisode) => {
      // Read off the STORED capture, not `effective*`: the overlay may still be
      // carrying an optimistic value from a save that has not been answered,
      // and restoring that would put back something never written.
      const prior: ExcludeUndo['prior'] = {
        review_status: row.capture.review_status,
        quality: row.capture.quality ?? null,
        quality_source: row.capture.quality_source ?? null,
      };
      const subject = subjectOf(row);
      void applyReview(
        row,
        { status: 'excluded', quality: 'Not usable' },
        {
          review_status: 'excluded',
          quality: 'not_usable',
          quality_source: 'operator',
        },
      ).then(({ capture }) => {
        // Only offer to undo a write that actually landed. A refusal has
        // already reverted the row, so there is nothing to take back — and an
        // Undo sitting under a conflict banner would invite the operator to
        // "restore" a capture this screen never changed.
        if (!capture) return;
        setExcludeUndo({ captureId: row.captureId, subject, prior });
        // The undo band announces itself (role="status"), so this does not
        // repeat the offer — two live regions saying "Undo available" in the
        // same breath is noise, and the band is the one with the button in it.
        showToast(`${subject} → Not usable · Excluded (recording kept)`);
      });
    },
    [applyReview, showToast],
  );

  const requestExclude = useCallback(
    (captureId: string) => {
      const row = decorated.find((r) => r.captureId === captureId);
      if (!row) return;
      if (row.isExcluded) {
        // The offer is for THIS exclusion, and the operator is undoing it by
        // another door. Dropping the memo here (the guard above already stops
        // it being shown) keeps it from coming back if the capture is excluded
        // again later by something that does not go through this function.
        if (excludeUndo?.captureId === captureId) setExcludeUndo(null);
        void applyReview(row, { status: 'pending' }, { review_status: 'pending' }).then(
          ({ capture }) => {
            // Says the step that is still outstanding. "Restored" read as
            // finished, and the capture sat at `pending` — invisible to
            // Datasets, which take adopted captures only.
            if (capture)
              showToast(
                `${subjectOf(row)} returned to review — Adopt to include in datasets`,
              );
          },
        );
        return;
      }
      excludeCapture(row);
    },
    [decorated, applyReview, showToast, excludeCapture, excludeUndo],
  );

  const undoExclude = useCallback(() => {
    const memo = excludeUndo;
    if (!memo) return;
    const row = decorated.find((r) => r.captureId === memo.captureId);
    if (!row) {
      // The capture left the catalog (deleted or discarded from elsewhere).
      // There is nothing to restore it onto, and keeping the offer would sit
      // there failing.
      setExcludeUndo(null);
      return;
    }
    // The precondition, re-checked at the moment of the write and not only at
    // render: an undo is only ever an undo while the exclusion it remembers is
    // still the capture's state. Excluding a PENDING capture and then adopting
    // it instead used to leave this offer standing, and taking it wrote
    // `pending` over the adoption — a silent demotion, reported as a success.
    // Whoever the second decision came from, theirs is the newer one.
    if (!row.isExcluded) {
      setExcludeUndo(null);
      return;
    }
    void applyReview(
      row,
      {
        status: memo.prior.review_status,
        // Only when there is a value to show. `undefined` leaves the overlay
        // alone, which is right: a prior of "no quality set" cannot be drawn
        // optimistically, and it settles on the server's answer either way.
        ...(memo.prior.quality
          ? { quality: displayQuality(memo.prior.quality) ?? undefined }
          : {}),
      },
      {
        review_status: memo.prior.review_status,
        // Sent explicitly, nulls included. The server tells "omitted" from
        // "null" by `model_fields_set`, and an omitted field means "leave it" —
        // which is how the capture would keep the `not_usable` the exclude
        // wrote on it. A null does NOT land as null, though: the server refills
        // an explicitly-null quality from the capture's own quick-check verdict
        // and marks it `quick_check`. That is the honest end state for a
        // quality no operator ever set — machine-judged again, rather than
        // carrying a verdict this screen put there and just took back.
        quality: memo.prior.quality,
        quality_source: memo.prior.quality_source,
      },
    ).then(({ capture }) => {
      // Kept on failure. The conflict/failure banner says what went wrong, and
      // the offer is still the operator's way to try again.
      if (!capture) return;
      setExcludeUndo(null);
      showToast(
        `${memo.subject} restored to ${describePrior(memo.prior)}` +
          // Said out loud, because the screen cannot put back a quality that
          // was never set: the server refills an explicitly-null quality from
          // the capture's quick check. Claiming a bare "restored to Pending"
          // would hide a value arriving from somewhere the operator did not
          // choose.
          (memo.prior.quality === null ? ' — quality re-derived from quick check' : ''),
      );
    });
  }, [excludeUndo, decorated, applyReview, showToast]);

  // What the strip is allowed to offer. The memo above records what an exclude
  // overwrote; this is whether that exclusion is STILL the capture's state.
  //
  // Derived rather than left to each route to remember, because the routes back
  // out of an exclusion are many — the row's Return, the detail panel's, a
  // batch return, Adopt, another terminal's save arriving on the poll — and
  // every one of them that forgot left an offer whose only remaining effect was
  // damage: excluding a PENDING capture, adopting it instead, then taking the
  // stale offer wrote `pending` over the adoption and called it a success.
  // A rule computed from the capture's own state cannot be forgotten by the
  // next route somebody adds.
  const excludeUndoOffer = useMemo(() => {
    if (!excludeUndo) return null;
    const row = decorated.find((r) => r.captureId === excludeUndo.captureId);
    return row?.isExcluded ? excludeUndo : null;
  }, [excludeUndo, decorated]);

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
      // An undo for a capture that no longer exists has nothing to restore
      // onto. Offering it would be a button whose only outcome is a failure.
      setExcludeUndo((cur) => (cur && ids.includes(cur.captureId) ? null : cur));
    },
    onToast: showToast,
  });
  const capturesById = useMemo(() => {
    const byId = new Map<string, CaptureListItem>();
    for (const row of decorated) byId.set(row.captureId, row.capture);
    return byId;
  }, [decorated]);
  const resolveTargets = useCallback(
    (ids: string[]) =>
      ids.map((id) => capturesById.get(id)).filter((c): c is CaptureListItem => !!c),
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

  // Both batch-level runs step through their targets identically (useBulkRun):
  // one save at a time, one cache sweep at the end, and a refusal reported BY
  // ID rather than dropped. Only the payload they save and what they say
  // afterwards differ, which is what stays written out here.
  const [excludeBatchOpen, setExcludeBatchOpen] = useState(false);
  const requestExcludeBatch = useCallback(() => {
    resetExcludeBatch();
    setExcludeBatchOpen(true);
  }, [resetExcludeBatch]);
  const cancelExcludeBatch = useCallback(() => {
    if (excludeBatch.running) return;
    setExcludeBatchOpen(false);
    resetExcludeBatch();
  }, [excludeBatch.running, resetExcludeBatch]);
  const confirmExcludeBatch = useCallback(() => {
    const targets = batchExcludable;
    if (!targets.length) {
      setExcludeBatchOpen(false);
      return;
    }
    // Supersede any "still excluded — return failed" notice. Those episodes
    // are about to be excluded on purpose, which leaves the sentence literally
    // true and completely misleading. Cleared HERE rather than when the dialog
    // opens: opening a dialog supersedes nothing, and the operator may still
    // be reading the notice while deciding whether to go ahead.
    resetReturnBatch();
    // Same reason the return notice goes: a single-capture undo offer sitting
    // over a batch that just excluded a dozen others reads as the undo for what
    // the operator did last, and it is not.
    setExcludeUndo(null);
    void (async () => {
      const outcome = await runExcludeBatch({
        items: targets,
        attempt: async (t) => {
          const { capture, error, skipped } = await applyReview(
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
          // Reported by id and NOT dropped: a capture that stayed in the ready
          // set because its save failed is exactly what the operator needs to
          // know before trusting the batch. The message comes from THIS save's
          // result — reading it off the hook's banner state would report
          // whichever failure happened to land there last.
          return capture ? null : batchFailure(t.captureId, error, skipped);
        },
        afterAll: () => reviewSave.invalidateList(),
      });
      if (!outcome) return;
      const { succeeded, failures } = outcome;
      if (failures.length === 0) {
        showToast(
          `Excluded ${succeeded} episode${succeeded === 1 ? '' : 's'} — recordings kept, reversible`,
        );
        setExcludeBatchOpen(false);
      } else {
        showToast(`Excluded ${succeeded}, ${failures.length} failed`);
      }
    })();
  }, [
    batchExcludable,
    applyReview,
    reviewSave,
    showToast,
    runExcludeBatch,
    resetReturnBatch,
  ]);

  const returnBatchToReview = useCallback(() => {
    const targets = batchExcluded;
    if (!targets.length) return;
    // Same rule as the single Return: if this sweep is about to un-exclude the
    // capture the offer belongs to, the offer is spent.
    if (excludeUndo && targets.some((t) => t.captureId === excludeUndo.captureId))
      setExcludeUndo(null);
    void (async () => {
      const outcome = await runReturnBatch({
        items: targets,
        attempt: async (t) => {
          const { capture, error, skipped } = await applyReview(
            t,
            { status: 'pending' },
            { review_status: 'pending' },
            { skipInvalidate: true },
          );
          // Same rule as the batch exclude: named by id, from THIS save's own
          // result. A capture that stayed excluded because its save failed is
          // the one fact the operator needs before trusting the count — and
          // "Returned 2" over a set of 3, with no mention of the third, is a
          // partial failure wearing a success's clothes.
          return capture ? null : batchFailure(t.captureId, error, skipped);
        },
        afterAll: () => reviewSave.invalidateList(),
      });
      if (!outcome) return;
      const { succeeded, failures } = outcome;
      showToast(
        failures.length === 0
          ? `Returned ${succeeded} episode${succeeded === 1 ? '' : 's'} to review — Adopt to include in datasets`
          : `Returned ${succeeded}, ${failures.length} failed`,
      );
    })();
  }, [batchExcluded, applyReview, reviewSave, showToast, runReturnBatch, excludeUndo]);

  // ---- decisions / overrides ---------------------------------------------
  const decide = useCallback(
    (d: Decision) => {
      if (!selected) return;
      // The detail panel's Exclude is the SAME operation as the table's, down
      // to the undo it leaves behind. It used to be a bare status write: no
      // quality change, nothing remembered, and no confirmation either — three
      // ways for the two entry points to disagree about what "Exclude" means.
      if (d === 'excluded') {
        excludeCapture(selected);
        return;
      }
      const wasExcluded = selected.isExcluded;
      // Every decision that is not "exclude" ends this exclusion, whichever it
      // is: Return takes it out, Adopt overrides it. The offer goes with it.
      if (excludeUndo?.captureId === selected.captureId) setExcludeUndo(null);
      void applyReview(
        selected,
        { status: toServerReview(d) },
        { review_status: toServerReview(d) },
      ).then(({ capture }) => {
        if (!capture) return;
        if (d === 'review') {
          // Same outstanding step as the table's Return: `pending` is not a
          // finished state, and Datasets take adopted captures only.
          showToast(
            `${subjectOf(selected)} ${wasExcluded ? 'returned to review' : 'reset to needs check'} — Adopt to include in datasets`,
          );
          return;
        }
        showToast(`${subjectOf(selected)} → ${d}`);
      });
    },
    [selected, applyReview, showToast, excludeCapture, excludeUndo],
  );

  // Adopt this capture — the one thing Datasets requires before a capture can
  // join a training set. It reads two ways depending on where the operator is:
  // "Mark OK — include" resolves a NEEDS CHECK exception, while on a READY
  // capture it is simply the adoption. One server effect either way.
  const markOk = useCallback(() => {
    if (!selected) return;
    const exception = selected.reviewLane === 'needs_check';
    // Adopting is the operator choosing the opposite of the exclusion they are
    // being offered a way back from. Theirs is the newer decision.
    if (excludeUndo?.captureId === selected.captureId) setExcludeUndo(null);
    void applyReview(selected, { status: 'adopted' }, { review_status: 'adopted' }).then(
      ({ capture }) => {
        if (capture) {
          showToast(
            exception
              ? `${subjectOf(selected)} marked OK — included`
              : `${subjectOf(selected)} adopted — datasets can use it`,
          );
        }
      },
    );
  }, [selected, applyReview, showToast, excludeUndo]);

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
      if (capture) showToast(`${subjectOf(selected)} quality → ${next}`);
    });
  }, [selected, applyReview, showToast]);

  const cycleTaskResult = useCallback(() => {
    if (!selected) return;
    // Unset base → the first click sets Success; thereafter it toggles.
    const next: DisplayTaskResult =
      selected.effectiveTask === 'Success' ? 'Failure' : 'Success';
    void applyReview(selected, { task: next }, { task_result: toServerTask(next) }).then(
      ({ capture }) => {
        if (capture) showToast(`${subjectOf(selected)} task result → ${next}`);
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
      pullCapture(captureId).catch((err: unknown) => {
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

  // While any transfer is in flight, sweep the list so an arriving replica is
  // seen promptly (TRANSFER_PROGRESS_POLL_MS).
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
    }, TRANSFER_PROGRESS_POLL_MS);
    return () => clearInterval(timer);
  }, [anyTransferring, queryClient]);

  // The FAILURE channel (S3-1): the replica sweep above can only ever confirm
  // arrival — a pull whose rsync died looked exactly like one still running,
  // and the slot said "Transferring…" forever. While anything is in flight,
  // read each pull's state off the importer and fail the slot when IT says
  // failed, with its one-line reason. Arrival stays replica-confirmed.
  const transferringIds = useMemo(
    () =>
      Object.entries(transfers)
        .filter(([, slot]) => slot.phase === 'transferring')
        .map(([id]) => id),
    [transfers],
  );
  useEffect(() => {
    if (transferringIds.length === 0) return;
    let cancelled = false;
    const timer = setInterval(() => {
      for (const id of transferringIds) {
        getPullStatus(id)
          .then((pull) => {
            if (cancelled || pull.state !== 'failed') return;
            failTransfer(
              [id],
              pull.reason
                ? `Transfer failed — ${pull.reason}`
                : 'Transfer failed (see the importer log)',
            );
          })
          .catch(() => {
            // 404 (importer restarted) or a transient read error: the replica
            // sweep remains the arrival signal, so nothing to change here.
          });
      }
    }, TRANSFER_PROGRESS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [transferringIds, failTransfer]);

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
    catalogTruncated,

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
    excludeBatchRunning: excludeBatch.running,
    excludeBatchDone: excludeBatch.done,
    excludeBatchFailures: excludeBatch.failures,
    confirmExcludeBatch,
    cancelExcludeBatch,
    returnBatchToReview,
    returnBatchFailures: returnBatch.failures,

    captureSubject,

    selectedCaptureId,
    select,
    selected,

    requestExclude,
    excludeUndo: excludeUndoOffer,
    undoExclude,
    dismissExcludeUndo,

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
