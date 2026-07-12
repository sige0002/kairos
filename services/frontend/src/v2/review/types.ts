// Domain types for the Review screen. `RunSummary` (api/types.ts) is the only
// real signal the backend gives us — quality / task result / batch grouping
// are Phase 2 concepts the orchestrator doesn't model per-run yet, so this
// screen fills them in with a deterministic mock (see mapRuns.ts) rather than
// inventing a fake API. Transfer status is our own addition (not in the
// design mock) for split robot/recording-PC deployments — see splitMode.ts.

export type Quality = 'Good' | 'Needs review' | 'Not usable';
export type TaskResult = 'Success' | 'Failure';
export type Decision = 'adopted' | 'review' | 'excluded';

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
  /** Grouping the backend doesn't track per-run yet (see mapRuns.ts). */
  batch: string;
  quality: Quality;
  task: TaskResult;
  durationMs?: number;
  startedAt?: string;
  /** Issue count for the table's ⚠ column; 0 renders blank like the mock. */
  warnCount: number;
  issues: string;
  /** Initial transfer status (mock seed); only surfaced when split mode is on. */
  transfer: TransferPhase;
}

/** An EpisodeRow plus the locally-applied overrides/decision/transfer state
 *  the table and detail panel actually render. */
export interface DecoratedEpisode extends EpisodeRow {
  effectiveQuality: Quality;
  effectiveTask: TaskResult;
  isArchived: boolean;
  decision: Decision | null;
  transferSlot: TransferSlot;
}
