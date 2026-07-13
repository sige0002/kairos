// Maps real /runs API rows into Review episodes. `RunSummary` carries no
// quality / task-result / batch concept (that's a Phase 2 backend model). Until
// that lands, those columns are filled — when present — from the client-side
// Collect→Review bridge (episodeBridge.ts), keyed by run_id: the operator's own
// Collect outcome for this browser, not a fabricated value. A run with no bridge
// entry stays UNSET (null → "—" in the UI).
//
// The one bit of REAL backend signal always wins over the bridge: a run that
// ended `failed`/`interrupted` is "Not usable" — the backend's own verdict — and
// the bridge is ignored for it entirely (a stale entry can never mask a failure).
// Everything a real recording actually has (state, operator, duration,
// started_at) comes straight from the API.
//
// `runs` in `created`/`recording`/`stopping` are excluded — there's nothing to
// review until a recording has actually finished (one way or another).

import type { EpisodeRow, Quality, TaskResult } from './types';
import type { RunSummary } from '../../api/types';
import { getEpisodeOutcome, type EpisodeOutcome } from '../episodeBridge';

/** Collect quality axis → Review display quality. Collect never emits
 *  "Not usable" (that is the backend's failed/interrupted verdict). */
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
  return ordered.map((run, i) => {
    const endedBadly = run.state === 'failed' || run.state === 'interrupted';
    // Backend truth wins: never consult the bridge for a run that didn't finish
    // cleanly, so a stale Collect entry can't mask a real failure.
    const outcome = endedBadly ? null : getOutcome(run.run_id);
    // The /runs list carries bytes (backend Run model), though the shared
    // RunSummary type omits it — read it defensively.
    const bytes = (run as RunSummary & { bytes?: number | null }).bytes;
    return {
      ep: i + 1,
      runId: run.run_id,
      state: run.state,
      // Batch grouping comes from the Collect bridge when present, else "—".
      batch: outcome ? String(outcome.batchNum) : '—',
      operator: run.operator ?? null,
      quality: endedBadly ? 'Not usable' : outcome ? bridgeQuality(outcome.quality) : null,
      task: outcome ? bridgeTask(outcome.taskResult) : null,
      durationMs: run.duration_ms ?? spanMs(run.started_at, run.ended_at),
      startedAt: run.started_at,
      bytes: bytes ?? null,
      issues: endedBadly ? 'Recording did not complete cleanly' : null,
      // Honest default: nothing has been transferred this session yet.
      transfer: 'on_robot',
    };
  });
}
