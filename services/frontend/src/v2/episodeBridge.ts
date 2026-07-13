// Client-side episode-outcome bridge: Collect → Review.
//
// The orchestrator has no Session/Batch/Episode model yet (Phase 2), so Collect's
// per-episode outcomes (quality / task result / batch grouping) live only in the
// operator's browser. This module is the narrow, shared conduit that lets the
// Review screen surface those outcomes on the matching run's row instead of a
// blank "—", keyed by the real `run_id` that both screens already share.
//
// It is deliberately SEPARATE from Collect's batch-session blob
// (`kairos.collect.batch`, which clears per batch): this map ACCUMULATES across
// batches and sessions, capped at the newest ~500 runs. When the Phase-2 backend
// lands, Review reads the server model instead and this module is retired.
//
// Honesty: the bridge only ever carries what the operator actually chose in
// Collect. It never overrides backend truth — a run the backend reports as
// failed/interrupted stays "Not usable" in Review regardless of any stale entry
// here (the read side in mapRuns.ts enforces that).

/** Collect's own quality axis (`review/useBatchMachine` Quality). Never
 *  'not usable' — that is a backend verdict, not something Collect emits. */
export type BridgeQuality = 'good' | 'review';
/** Collect's task-outcome axis (`review/useBatchMachine` TaskResult). */
export type BridgeTaskResult = 'ok' | 'fail';

/** One episode's operator-chosen outcome, mirrored from a saved Collect episode. */
export interface EpisodeOutcome {
  quality: BridgeQuality;
  taskResult: BridgeTaskResult;
  /** Set only when taskResult === 'fail'. */
  failReason?: string;
  /** Collect batch number this episode belonged to. */
  batchNum: number;
  /** 1-based index of the episode within its batch. */
  episodeIndex: number;
  /** Epoch ms the outcome was saved — the eviction key for the size cap. */
  savedAt: number;
}

// Versioned key: a future shape change bumps the suffix rather than trying to
// migrate an old blob in place.
const STORAGE_KEY = 'kairos.v2.episodeOutcomes.v1';
const MAX_ENTRIES = 500;

type OutcomeMap = Record<string, EpisodeOutcome>;

function readMap(): OutcomeMap {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as OutcomeMap;
  } catch {
    return {};
  }
}

function writeMap(map: OutcomeMap): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // localStorage unavailable (private mode / SSR): the bridge is a
    // best-effort convenience, so a failed write is silently non-fatal.
  }
}

function isOutcome(v: unknown): v is EpisodeOutcome {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    (o.quality === 'good' || o.quality === 'review') &&
    (o.taskResult === 'ok' || o.taskResult === 'fail') &&
    typeof o.batchNum === 'number' &&
    typeof o.episodeIndex === 'number' &&
    typeof o.savedAt === 'number'
  );
}

/** Mirror a saved Collect episode's outcome into the bridge, keyed by run_id.
 *  Enforces the size cap by evicting the oldest entries (by savedAt). */
export function saveEpisodeOutcome(runId: string, outcome: EpisodeOutcome): void {
  if (!runId) return;
  const map = readMap();
  map[runId] = outcome;
  const ids = Object.keys(map);
  if (ids.length > MAX_ENTRIES) {
    ids
      .sort((a, b) => (map[a]!.savedAt ?? 0) - (map[b]!.savedAt ?? 0)) // oldest first
      .slice(0, ids.length - MAX_ENTRIES)
      .forEach((id) => delete map[id]);
  }
  writeMap(map);
}

/** The operator-chosen outcome for a run, or null when none is recorded (the
 *  honest "—" default) or the stored entry is malformed. */
export function getEpisodeOutcome(runId: string): EpisodeOutcome | null {
  if (!runId) return null;
  const o = readMap()[runId];
  return isOutcome(o) ? o : null;
}

/** Drop a run's outcome — called when its recording is discarded/deleted so no
 *  stale entry lingers for a run that no longer exists. */
export function removeEpisodeOutcome(runId: string): void {
  if (!runId) return;
  const map = readMap();
  if (runId in map) {
    delete map[runId];
    writeMap(map);
  }
}

/** Test-only: wipe the whole bridge so cases don't leak into each other. */
export function __clearEpisodeOutcomes(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
