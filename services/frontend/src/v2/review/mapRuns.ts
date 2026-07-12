// Maps real /runs API rows into Review episodes. `RunSummary` carries no
// quality / task-result / batch concept (that's a Phase 2 backend model), so
// this fills those in with a deterministic hash of the run id — stable across
// re-fetches/re-renders (not Math.random(), which would relabel every
// episode's quality on every refetch) but clearly synthetic. The one bit of
// REAL signal folded in: a run that ended in `failed`/`interrupted` is always
// shown as "Not usable" — that's the backend's own verdict, not a guess.
//
// `runs` in `created`/`recording`/`stopping` are excluded — there's nothing to
// review until a recording has actually finished (one way or another).

import type { EpisodeRow, Quality, TaskResult, TransferPhase } from './types';
import type { RunSummary } from '../../api/types';

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

const ISSUE_TEXTS = [
  'Right camera rate drop',
  'Recorder gap detected',
  'IMU delay observed',
  'Sync drift observed',
];

function mockQualityAndIssues(runId: string): { quality: Quality; warnCount: number; issues: string } {
  const bucket = hash(runId) % 10;
  if (bucket < 6) return { quality: 'Good', warnCount: 0, issues: 'None' };
  const text = ISSUE_TEXTS[hash(`${runId}i`) % ISSUE_TEXTS.length]!;
  const warnCount = 1 + (hash(`${runId}w`) % 2);
  return { quality: bucket < 9 ? 'Needs review' : 'Not usable', warnCount, issues: text };
}

function mockTask(runId: string): TaskResult {
  return hash(`${runId}t`) % 5 === 0 ? 'Failure' : 'Success';
}

function mockTransferSeed(runId: string): TransferPhase {
  return hash(`${runId}x`) % 2 === 0 ? 'transferred' : 'on_robot';
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
    const mock = mockQualityAndIssues(run.run_id);
    return {
      ep: i + 1,
      runId: run.run_id,
      // No per-run batch model exists yet — real rows always show "—" rather
      // than a number that would look like a real grouping.
      batch: '—',
      quality: endedBadly ? 'Not usable' : mock.quality,
      task: mockTask(run.run_id),
      durationMs: run.duration_ms ?? spanMs(run.started_at, run.ended_at),
      startedAt: run.started_at,
      warnCount: endedBadly ? Math.max(1, mock.warnCount) : mock.warnCount,
      issues: endedBadly ? 'Recording did not complete cleanly' : mock.issues,
      transfer: mockTransferSeed(run.run_id),
    };
  });
}

function hmsToMs(hms: string): number {
  const [h = 0, m = 0, s = 0] = hms.split(':').map(Number);
  return ((h * 3600 + m * 60 + s) * 1000);
}

function todayAt(hms: string): string {
  const [h = 0, m = 0, s = 0] = hms.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, s, 0);
  return d.toISOString();
}

/**
 * Small built-in demo set shown when the /runs API is unreachable, so the
 * screen still demos instead of going blank. Mirrors the design mock's own
 * sample data (reviewData in kairos-console-v2.dc.html) almost verbatim —
 * since these rows have zero real backing anyway, showing the mock's batch
 * numbers here (unlike the "—" real rows get above) is honest: the whole row
 * is understood as a demo fixture, not a real recording with a fake batch
 * grafted onto it.
 */
export const FALLBACK_EPISODES: EpisodeRow[] = [
  { ep: 28, runId: 'demo_ep_28', batch: '5', quality: 'Good', task: 'Success', durationMs: hmsToMs('00:00:58'), startedAt: todayAt('15:32:10'), warnCount: 0, issues: 'None', transfer: 'transferred' },
  { ep: 27, runId: 'demo_ep_27', batch: '5', quality: 'Needs review', task: 'Success', durationMs: hmsToMs('00:00:28'), startedAt: todayAt('15:29:21'), warnCount: 2, issues: 'Right camera rate drop (2)', transfer: 'transferred' },
  { ep: 26, runId: 'demo_ep_26', batch: '5', quality: 'Not usable', task: 'Failure', durationMs: hmsToMs('00:01:12'), startedAt: todayAt('15:27:05'), warnCount: 1, issues: 'Recorder gap 1.2 s', transfer: 'on_robot' },
  { ep: 25, runId: 'demo_ep_25', batch: '5', quality: 'Good', task: 'Success', durationMs: hmsToMs('00:00:51'), startedAt: todayAt('15:24:40'), warnCount: 0, issues: 'None', transfer: 'transferred' },
  { ep: 24, runId: 'demo_ep_24', batch: '4', quality: 'Needs review', task: 'Success', durationMs: hmsToMs('00:01:03'), startedAt: todayAt('15:21:10'), warnCount: 1, issues: 'IMU delay 0.4 s', transfer: 'on_robot' },
  { ep: 23, runId: 'demo_ep_23', batch: '4', quality: 'Good', task: 'Success', durationMs: hmsToMs('00:00:49'), startedAt: todayAt('15:18:33'), warnCount: 0, issues: 'None', transfer: 'transferred' },
  { ep: 22, runId: 'demo_ep_22', batch: '4', quality: 'Good', task: 'Failure', durationMs: hmsToMs('00:00:44'), startedAt: todayAt('15:15:02'), warnCount: 0, issues: 'None', transfer: 'on_robot' },
  { ep: 21, runId: 'demo_ep_21', batch: '4', quality: 'Good', task: 'Success', durationMs: hmsToMs('00:00:57'), startedAt: todayAt('15:12:48'), warnCount: 0, issues: 'None', transfer: 'transferred' },
];
