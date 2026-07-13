// Maps real /runs API rows into Review episodes. Quality / task result / batch
// come from the Phase 2 server episode joined onto each run (`run.episode`) when
// present — real data on any terminal. For a run with no server episode (e.g.
// recorded before Phase 2, or while the API was down) we fall back to the
// browser-local Collect→Review bridge (episodeBridge.ts), keyed by run_id. A run
// with neither stays UNSET (null → "—" in the UI); nothing is fabricated.
//
// The one bit of REAL backend signal always wins over both: a run that ended
// `failed`/`interrupted` is "Not usable" — the backend's own verdict — and both
// the server episode and the bridge are ignored for it (neither can mask a
// failure). Everything a real recording actually has (state, operator, duration,
// started_at) comes straight from the API.
//
// `runs` in `created`/`recording`/`stopping` are excluded — there's nothing to
// review until a recording has actually finished (one way or another).

import type { EpisodeRow, Quality, TaskResult } from './types';
import type { EpisodeQuality, EpisodeTaskResult, RunSummary } from '../../api/types';
import { getEpisodeOutcome, type EpisodeOutcome } from '../episodeBridge';

/** Server quality → Review display quality. */
function serverQuality(q: EpisodeQuality): Quality {
  if (q === 'needs_review') return 'Needs review';
  if (q === 'not_usable') return 'Not usable';
  return 'Good';
}
function serverTask(t: EpisodeTaskResult): TaskResult {
  return t === 'failure' ? 'Failure' : 'Success';
}

/** Bridge (Collect-local) quality/task → Review display. The bridge never
 *  carries "Not usable" (that is the backend's failed/interrupted verdict). */
function bridgeQuality(q: EpisodeOutcome['quality']): Quality {
  return q === 'review' ? 'Needs review' : 'Good';
}
function bridgeTask(t: EpisodeOutcome['taskResult']): TaskResult {
  return t === 'fail' ? 'Failure' : 'Success';
}

/** Milliseconds between two ISO instants (undefined when indeterminate). */
function spanMs(started?: string, ended?: string | null): number | undefined {
  if (!started || !ended) return undefined;
  const s = Date.parse(started);
  const e = Date.parse(ended);
  if (Number.isNaN(s) || Number.isNaN(e) || e < s) return undefined;
  return e - s;
}

const REVIEWABLE = new Set(['completed', 'failed', 'interrupted']);

export function mapRunsToEpisodes(
  runs: RunSummary[],
  // Injectable for tests; defaults to the real client-side bridge.
  getOutcome: (runId: string) => EpisodeOutcome | null = getEpisodeOutcome,
): EpisodeRow[] {
  const reviewable = runs.filter((r) => REVIEWABLE.has(r.state));
  // Oldest first so #1 is the earliest recording and numbers only ever grow;
  // falls back to run_id ordering when a run has no started_at.
  const ordered = [...reviewable].sort((a, b) => {
    const ta = a.started_at ? Date.parse(a.started_at) : NaN;
    const tb = b.started_at ? Date.parse(b.started_at) : NaN;
    if (!Number.isNaN(ta) && !Number.isNaN(tb)) return ta - tb;
    return a.run_id.localeCompare(b.run_id);
  });
  // The server episode has no friendly batch number, so assign a display ordinal
  // per distinct batch key in started_at order (oldest batch = 1). Server rows
  // key on batch_id; bridge rows on their stored batchNum — a stable label for
  // grouping either way.
  const batchOrdinals = new Map<string, number>();
  const batchLabel = (key: string | null): string => {
    if (!key) return '—';
    let n = batchOrdinals.get(key);
    if (n === undefined) {
      n = batchOrdinals.size + 1;
      batchOrdinals.set(key, n);
    }
    return String(n);
  };

  return ordered.map((run, i) => {
    const endedBadly = run.state === 'failed' || run.state === 'interrupted';
    // Backend truth wins: never consult the episode/bridge for a run that didn't
    // finish cleanly, so a stale entry can't mask a real failure.
    const episode = endedBadly ? null : (run.episode ?? null);
    const outcome = endedBadly || episode ? null : getOutcome(run.run_id);
    // The /runs list carries bytes (backend Run model), though the shared
    // RunSummary type omits it — read it defensively.
    const bytes = (run as RunSummary & { bytes?: number | null }).bytes;

    // Precedence: server episode > bridge > "—" (session overrides are layered
    // on top later, in useReviewState's decorated map).
    let quality: Quality | null;
    let task: TaskResult | null;
    let batchKey: string | null;
    if (endedBadly) {
      quality = 'Not usable';
      task = null;
      batchKey = null;
    } else if (episode) {
      quality = serverQuality(episode.quality);
      task = serverTask(episode.task_result);
      batchKey = episode.batch_id;
    } else if (outcome) {
      quality = bridgeQuality(outcome.quality);
      task = bridgeTask(outcome.taskResult);
      batchKey = `bridge:${outcome.batchNum}`;
    } else {
      quality = null;
      task = null;
      batchKey = null;
    }

    return {
      ep: i + 1,
      runId: run.run_id,
      episodeId: episode?.episode_id ?? null,
      state: run.state,
      batch: batchLabel(batchKey),
      operator: run.operator ?? null,
      quality,
      task,
      durationMs: run.duration_ms ?? spanMs(run.started_at, run.ended_at),
      startedAt: run.started_at,
      bytes: bytes ?? null,
      issues: endedBadly ? 'Recording did not complete cleanly' : null,
      // Honest default: nothing has been transferred this session yet.
      transfer: 'on_robot',
    };
  });
}
