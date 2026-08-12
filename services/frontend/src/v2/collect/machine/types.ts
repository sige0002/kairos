// Domain vocabulary and constants of the Collect batch machine, split out of
// useBatchMachine.ts (which re-exports everything here — external imports are
// unchanged).

import type { ReviewStatus } from '../../../api/types';

export type Phase =
  | 'ready'
  | 'arming'
  | 'recording'
  | 'saving'
  | 'quickcheck'
  | 'result'
  | 'paused'
  | 'ended'
  | 'completed';

// Two independent axes — NOT one merged bucket. A failed task still produced
// a usable, labeled recording (see docs/specs: Datasets "include failures:
// yes, labeled"); collapsing them into a single "not usable" result would
// contradict that. `quality` has no 'bad'/'not usable' value yet in Phase 1 —
// that would come from full (post-recording) validation, which doesn't exist
// here — so the only quality signal available live is the review flag.
export type Quality = 'good' | 'review';
export type TaskResult = 'ok' | 'fail';

// The operator's optional quality override on the result panel. 'notusable' has
// no local EpisodeRecord equivalent (see Quality) — it maps to 'review' for the
// strip/tallies and to the server 'not_usable' on save.
export type QualityOverride = 'good' | 'review' | 'notusable';

// A recorder error carried to the UI: `code` is the machine-readable code
// (e.g. `already_recording`) when the backend/transport gave one, so ControlCard
// can show friendly copy and a muted `(code)` line; null when only a message.
export interface MachineError {
  code: string | null;
  message: string;
}

/** Why Stop is refused right now (M2). `floor` = the take is younger than
 *  STOP_FLOOR_MS. */
export type StopBlockedReason = 'floor' | null;

/** Minimum life of a take before Stop is accepted. A real double-click's second
 *  press lands tens of milliseconds after the first (qa-ui measured 86ms), and
 *  no deliberate recording is a second long. */
export const STOP_FLOOR_MS = 1000;

/** The same double-click, one phase earlier (#8): ARMING replaces the Start
 *  button with Cancel in nearly the same hit-area, so the second press landed
 *  on Cancel and backed out of the take the first press had just begun. Cancel
 *  therefore ignores its first this-many milliseconds on screen.
 *
 *  Well clear of the measured 86ms tail and far short of a deliberate press:
 *  the operator has to read ARMING… before deciding to back out. Unlike the
 *  Stop floor this is a property of the CONTROL, not of the take, so it is
 *  armed by the card appearing rather than by the recorder's clock. */
export const ARMING_CANCEL_GUARD_MS = 350;

export interface EpisodeRecord {
  index: number;
  /** Recording/data quality — independent of whether the task succeeded. */
  quality: Quality;
  /** Whether the demonstrated task succeeded — independent of data quality. */
  taskResult: TaskResult;
  /** The capture this episode labels — the only identity (§1). Absent only for
   *  a take the recorder never named. */
  captureId?: string;
  failReason?: string;
}

/** Plain-language "Task outcome: …" line for the episode-result summary. */
export function describeTaskOutcome(
  pendingTask: 'ok' | 'fail' | null,
  failReason: string,
): string {
  if (pendingTask === 'ok') return 'Success.';
  if (pendingTask === 'fail') {
    return failReason
      ? `Failed — ${failReason.toLowerCase()}.`
      : 'Failed — choose a reason below.';
  }
  return '—';
}

/** Human labels for the effective quality shown on the result panel. */
export const QUALITY_LABEL: Record<QualityOverride, string> = {
  good: 'Good',
  review: 'Needs review',
  notusable: 'Not usable',
};

/**
 * The `review_status` a Collect save stamps on the capture (§4.1).
 *
 * "Save — success" on good data IS the adoption. Treating it as a mere label
 * and leaving the capture `pending` left the two screens pointing at each
 * other: Review's READY lane offers nothing to click (it is, correctly, the
 * lane that needs no attention) while the Datasets rail refuses anything not
 * adopted — so the best takes could never enter a training set, and only the
 * ones that went through NEEDS CHECK could. Asking for a second ceremony
 * elsewhere to confirm a judgment already made in one click is the same mistake
 * as making an operator retype a discard reason.
 *
 * Only that combination adopts. A failed task, or data the quick check (or the
 * operator) called needs-review, stays `pending` and lands in NEEDS CHECK where
 * "Mark OK — include" is the deliberate confirmation. Data the operator called
 * not usable is `excluded` outright — the same statement Review's exclude
 * makes, and leaving it pending would put it straight back into the queue it
 * was just taken out of.
 *
 * `quality` here is the EFFECTIVE value the result panel was showing when the
 * operator committed: their override if they made one, else the auto value.
 * With no settled verdict yet that auto value is the fallback 'good', so this
 * function can propose an adoption for data nobody has measured. That is why
 * the request carries no `quality` unless the operator overrode it: the server
 * derives the quality, and when its verdict lands and is NOT good it moves the
 * capture back to `pending` — NEEDS CHECK — rather than leaving it adopted in
 * READY (§4.1, RecordService.reconcile_quality). An override is stamped
 * `quality_source: 'operator'` and is never re-derived; claiming that
 * provenance for a value nobody chose would disable the correction for good.
 */
export function collectReviewStatus(
  /** This screen's own vocabulary: 'ok' is what the wire calls `success`. */
  taskResult: TaskResult,
  quality: QualityOverride,
): ReviewStatus {
  if (quality === 'notusable') return 'excluded';
  return taskResult === 'ok' && quality === 'good' ? 'adopted' : 'pending';
}

// The plan catalog (Projects → Tasks → Conditions) AND the fail-reason
// vocabulary now live in the shared v2/plans store so a Settings edit reflects
// here immediately. This screen reads the live catalog (getPlans / usePlans,
// useFailReasons) rather than a private copy.

export const END_REASONS = [
  'Work time over',
  'Equipment / system problem',
  'Condition change',
  'Safety',
  'Plan change',
  'Other',
];

export interface AdviceItem {
  badge: string;
  title: string;
  detail: string;
}

// Advice generation is intentionally NOT implemented — one fixed placeholder
// item, per the design decision (see the Collect task brief).
export const ADVICE_ITEMS: AdviceItem[] = [
  {
    badge: 'QUALITY',
    title: 'Hold still for ~1 s before starting',
    detail:
      'The first second after Start stabilizes the initial state the model learns ' +
      'from — a brief pause before moving improves this episode.',
  },
];

export const EPISODES_PER_BATCH = 30;
// Quick-check waits for the real integrity signal from /record/status; this is
// only the backstop if that signal never lands (e.g. an older backend that
// doesn't classify integrity) so the operator is never stuck on QUICK CHECK.
export const QUICKCHECK_FALLBACK_MS = 3000;
// A just-saved episode's strip chip flashes a teal ring for this long.
export const SAVED_FLASH_MS = 1200;
// An unsaved take older than this is no longer offered for recovery.
export const UNSAVED_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Pre-arm keep-alive: re-prepare this long BEFORE the armed session's
// disarm_at deadline (covers request latency + the status-poll lag).
export const PREARM_KEEPALIVE_LEAD_MS = 20_000;
// Retry cadence after a failed prepare (or when disarm_at is unknown).
export const PREARM_RETRY_MS = 30_000;
// Failed prepares back off (doubling from PREARM_RETRY_MS) up to this cap: a
// persistent arm blocker does not need a probe every 30 s, and before the
// recorder-side S2-7 fix each probe minted a failed capture.
export const PREARM_RETRY_MAX_MS = 300_000;
// Surface `preArmDegraded` only after this many CONSECUTIVE failures — a
// single failure is usually a lost race with a start, not a condition.
export const PREARM_DEGRADED_AFTER_FAILURES = 2;

// The ledger reasons for Collect's one-click discards. Nobody typed these —
// recording that no reason was asked is the honest entry, and it keeps the
// tombstone distinguishable from a Review discard where an operator DID stand
// by an answer.
export const COLLECT_DISCARD_REASON = 'Collect one-click discard (no reason asked)';
// The retake path writes its own ledger reason, so the discarded attempt is
// traceable as "we tried this same thing again" instead of a mystery gap.
export const RETAKE_DISCARD_REASON = 'Superseded by retake (Collect)';
export const COLLECT_UNSAVED_DISCARD_REASON =
  'Collect recovery-banner discard of an unsaved take (no reason asked)';
// A start the operator backed out of during ARMING still reaches the recorder,
// so the sub-second bag it wrote is discarded rather than left in the catalog
// as a take nobody meant to make (#8). The ledger says which gesture it was.
export const CANCELLED_START_DISCARD_REASON =
  'Start cancelled during arming (Collect)';

/**
 * Why Start is refused when nobody has said who is recording (#11).
 *
 * One string for two surfaces — the note under the disabled Start button, and
 * the toast when the R shortcut walks around that button — because a gate the
 * operator meets on their very first visit cannot afford two different
 * accounts of itself.
 *
 * Written for someone who has never seen this console: the condition first (so
 * it reads as a state, not a scolding), then the control BY THE LABEL PRINTED
 * ON IT, then why it is worth the extra step. "OP" is what the chip in the
 * header actually says while empty, so pointing at it needs no jargon.
 */
export const OPERATOR_GATE_HINT =
  'No name set yet — click OP at the top right to add yours. ' +
  'Every recording has to say who made it.';
