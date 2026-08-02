// Domain types for the Review screen.
//
// A capture (api/types.ts) is the real signal: v2 merged the run and the
// episode, so quality, task result, batch grouping and adopt/exclude all live
// on the capture itself and are saved back through one compare-and-swap
// endpoint. This module holds only the DISPLAY vocabulary — the capitalised
// words the operator reads — and the lane the table sorts by.
//
// The display vocabulary is deliberately separate from the server enums: the
// server speaks `not_usable`, the operator reads "Not usable", and letting the
// wire format leak into table cells is how the two drift.

import type { Capture, CaptureState, ReviewStatus } from '../../api/types';

export type DisplayQuality = 'Good' | 'Needs review' | 'Not usable';
export type DisplayTaskResult = 'Success' | 'Failure';
/** What the operator decides about a capture. `review` = keep it in review. */
export type Decision = 'adopted' | 'review' | 'excluded';

/** Exception-review lane (the operator's mental model): READY captures need no
 *  clicks; NEEDS CHECK is the exception queue to look at; EXCLUDED is set
 *  aside. READY = not excluded AND (quality Good OR adopted). */
export type ReviewLane = 'ready' | 'needs_check' | 'excluded';

/**
 * Whether a capture's bytes have reached this machine yet.
 *
 * Only meaningful on a split deployment, where the recorder writes on the robot
 * and the recording PC pulls finished captures across. `awaiting` is a normal
 * state, not a failure: §12 requires the UI to render a capture that has review
 * data but no local copy, because reviewing before the bytes arrive is the
 * intended split-deploy order.
 */
export type TransferPhase = 'awaiting' | 'transferring' | 'here';

export interface TransferSlot {
  /** No percentage: rsync progress is not observable through the pull channel,
   *  so the UI shows an indeterminate "transferring", never a made-up %. */
  phase: TransferPhase;
}

/** One reviewable capture, as the table and detail panel render it.
 *
 * Everything here is derived from the capture; nothing is invented. A field the
 * capture does not carry stays null and renders "—". */
export interface EpisodeRow {
  /** Stable display number: the server's `index_in_batch` when the capture has
   *  one — excluding or deleting a neighbour must not renumber what remains —
   *  else a positional fallback. */
  ep: number;
  /** The identity everything keys on (§1). */
  captureId: string;
  /** `run_YYYYMMDD_HHMMSS`, DISPLAY ONLY. Never used as an API key. */
  runId: string | null;
  /** The compare-and-swap token for the next review save. 0 = never reviewed. */
  reviewRevision: number;
  state: CaptureState;
  /** "MM/DD · #N" when the capture's batch number is known, else "—". */
  batch: string;
  batchId: string | null;
  operator: string | null;
  /** The backend's own verdict wins: a capture that ended `failed` or
   *  `interrupted` is "Not usable" whatever the review says, because no review
   *  can make an incomplete recording usable. */
  quality: DisplayQuality | null;
  task: DisplayTaskResult | null;
  /** WHY the task failed — the operator's reason, picked at save time. */
  failReason: string | null;
  reviewStatus: ReviewStatus;
  durationMs?: number;
  startedAt?: string;
  /** Real on-disk size; null when unknown. Shown in the delete confirmation so
   *  the operator sees how much storage is actually reclaimed. */
  bytes: number | null;
  /** Real issue note when the recording itself failed; null for a clean one. */
  issues: string | null;
  transfer: TransferPhase;
  /** The capture this row was built from — the source for the availability
   *  chip, the deletion dialogs (which are obliged to state count and bytes)
   *  and the detail panel, so none of them re-derives or re-fetches it. */
  capture: Capture;
}

/** An EpisodeRow plus the session state layered on top: the operator's
 *  in-flight decision, the lane it lands in, and its transfer slot. */
export interface DecoratedEpisode extends EpisodeRow {
  effectiveQuality: DisplayQuality | null;
  effectiveTask: DisplayTaskResult | null;
  /** True when this capture is set aside (`review_status === 'excluded'`). */
  isExcluded: boolean;
  decision: Decision | null;
  effectiveReviewStatus: ReviewStatus;
  reviewLane: ReviewLane;
  transferSlot: TransferSlot;
}
