// Maps real /runs API rows into Review episodes. `RunSummary` carries no
// quality / task-result / batch concept (that's a Phase 2 backend model), so
// those stay UNSET on the base row (null → "—" in the UI) rather than being
// fabricated. The one bit of REAL signal folded in: a run that ended
// `failed`/`interrupted` is shown as "Not usable" — that's the backend's own
// verdict, not a guess. Everything a real recording actually has (state,
// operator, duration, started_at) comes straight from the API.
//
// `runs` in `created`/`recording`/`stopping` are excluded — there's nothing to
// review until a recording has actually finished (one way or another).

import type { EpisodeRow } from './types';
import type { RunSummary } from '../../api/types';

/** Milliseconds between two ISO instants (undefined when indeterminate). */
function spanMs(started?: string, ended?: string | null): number | undefined {
  if (!started || !ended) return undefined;
  const s = Date.parse(started);
  const e = Date.parse(ended);
  if (Number.isNaN(s) || Number.isNaN(e) || e < s) return undefined;
  return e - s;
}

const REVIEWABLE = new Set(['completed', 'failed', 'interrupted']);

export function mapRunsToEpisodes(runs: RunSummary[]): EpisodeRow[] {
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
    // The /runs list carries bytes (backend Run model), though the shared
    // RunSummary type omits it — read it defensively.
    const bytes = (run as RunSummary & { bytes?: number | null }).bytes;
    return {
      ep: i + 1,
      runId: run.run_id,
      state: run.state,
      // No per-run batch model exists yet — always "—".
      batch: '—',
      operator: run.operator ?? null,
      quality: endedBadly ? 'Not usable' : null,
      task: null,
      durationMs: run.duration_ms ?? spanMs(run.started_at, run.ended_at),
      startedAt: run.started_at,
      bytes: bytes ?? null,
      issues: endedBadly ? 'Recording did not complete cleanly' : null,
      // Honest default: nothing has been transferred this session yet.
      transfer: 'on_robot',
    };
  });
}
