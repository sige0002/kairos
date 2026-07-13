// Domain types for the Review screen. `RunSummary` (api/types.ts) is the real
// signal the backend gives us. Quality / task result / batch grouping are
// Phase 2 concepts the orchestrator doesn't model per-run yet, so the base
// row leaves them UNSET (null → "—" in the UI) rather than fabricating a
// value; the one real verdict folded in is that a `failed`/`interrupted` run
// is "Not usable". Quality/Task become concrete only when the operator sets
// them locally this session (the click-to-cycle cells). Transfer status is our
// own addition (not in the design mock) for split robot/recording-PC
// deployments — see splitMode.ts.

import type { RunState } from '../../api/types';

export type Quality = 'Good' | 'Needs review' | 'Not usable';
export type TaskResult = 'Success' | 'Failure';
export type Decision = 'adopted' | 'review' | 'excluded';
/** Server-facing adopt/exclude state shown as a status chip on each row. */
export type ReviewStatus = 'pending' | 'adopted' | 'excluded';
/** Exception-review lane (the operator's mental model): READY episodes export
 *  with zero clicks; NEEDS CHECK is the exception queue to look at; EXCLUDED is
 *  set aside. READY = not excluded AND (quality Good OR confirmed/adopted). */
export type ReviewLane = 'ready' | 'needs_check' | 'excluded';

/** MCAP transfer status for a split deployment: the episode's MCAP lives on
 *  the robot PC until explicitly transferred to the recording PC. */
export type TransferPhase = 'on_robot' | 'transferring' | 'transferred';

export interface TransferSlot {
  phase: TransferPhase;
  /** 0-100; meaningful only while `phase === 'transferring'` (100 once done). */
  pct: number;
}

/** One reviewable recording, before any local overrides are applied. */
export interface EpisodeRow {
  /** Stable display number: index+1 in started_at order (oldest = 1), so
   *  numbers never get reassigned as decisions/archival change. */
  ep: number;
  /** Full backend run id — kept for API calls / deep links / title attrs. */
  runId: string;
  /** Server episode id (Phase 2) when this run has one, else null. Non-null
   *  means quality/result/adopt-exclude changes PATCH the server episode; null
   *  means the row is local-only (bridge fallback or no episode). */
  episodeId: string | null;
  /** Real terminal run state (completed/failed/interrupted); drives the header
   *  badge fallback when the operator hasn't set a quality/decision. */
  state: RunState;
  /** Collect batch number from the client-side bridge when present, else "—"
   *  (the backend doesn't track per-run batch grouping yet). */
  batch: string;
  /** Real operator string (RunSummary.operator); null when the run has none. */
  operator: string | null;
  /** "Not usable" for a run that didn't finish cleanly (backend verdict, always
   *  wins); otherwise the operator's Collect-session quality from the bridge, or
   *  null when neither applies (the UI shows "—"). */
  quality: Quality | null;
  /** The operator's Collect-session task result from the bridge, or null when
   *  none is recorded (no automated task-result model exists). */
  task: TaskResult | null;
  /** Server episode's adopt/exclude state (null when the run has no episode). */
  reviewStatus: ReviewStatus | null;
  durationMs?: number;
  startedAt?: string;
  /** Real on-disk size in bytes (RunSummary carries it); null when unknown.
   *  Surfaced in the delete-from-disk confirmation so the operator sees how
   *  much storage is reclaimed. */
  bytes: number | null;
  /** Real issue note when the run itself failed; null for a clean run (there's
   *  no list-time per-topic issue source — that's the on-demand loss report). */
  issues: string | null;
  /** Initial transfer status; only surfaced when split mode is on. Seeds to
   *  on_robot (nothing transferred yet this session) — no fabricated state. */
  transfer: TransferPhase;
}

/** An EpisodeRow plus the locally-applied overrides/decision/transfer state
 *  the table and detail panel actually render. `effectiveQuality`/`effectiveTask`
 *  stay null until either the real signal or an operator override supplies one. */
export interface DecoratedEpisode extends EpisodeRow {
  effectiveQuality: Quality | null;
  effectiveTask: TaskResult | null;
  isArchived: boolean;
  decision: Decision | null;
  /** Adopt/exclude state: the session decision wins, else the server episode's
   *  review_status, else 'pending'. */
  effectiveReviewStatus: ReviewStatus;
  /** The exception-review lane derived from status + quality (the row's chip). */
  reviewLane: ReviewLane;
  transferSlot: TransferSlot;
}
