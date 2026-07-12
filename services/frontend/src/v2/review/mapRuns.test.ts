import { expect, test } from 'vitest';
import type { RunSummary } from '../../api/types';
import { FALLBACK_EPISODES, mapRunsToEpisodes } from './mapRuns';

function run(overrides: Partial<RunSummary>): RunSummary {
  return { run_id: 'run_1', state: 'completed', ...overrides };
}

test('excludes runs that never finished (created/recording/stopping)', () => {
  const rows = mapRunsToEpisodes([
    run({ run_id: 'a', state: 'created' }),
    run({ run_id: 'b', state: 'recording' }),
    run({ run_id: 'c', state: 'stopping' }),
    run({ run_id: 'd', state: 'completed' }),
  ]);
  expect(rows.map((r) => r.runId)).toEqual(['d']);
});

test('assigns ep numbers oldest-first (ep 1 is the earliest recording)', () => {
  const rows = mapRunsToEpisodes([
    run({ run_id: 'newer', started_at: '2026-07-13T10:00:00Z' }),
    run({ run_id: 'older', started_at: '2026-07-13T09:00:00Z' }),
  ]);
  expect(rows.find((r) => r.runId === 'older')?.ep).toBe(1);
  expect(rows.find((r) => r.runId === 'newer')?.ep).toBe(2);
});

test('a failed or interrupted run is always "Not usable" regardless of the mock hash', () => {
  const rows = mapRunsToEpisodes([
    run({ run_id: 'fail-1', state: 'failed' }),
    run({ run_id: 'fail-2', state: 'interrupted' }),
  ]);
  expect(rows.every((r) => r.quality === 'Not usable')).toBe(true);
  expect(rows.every((r) => r.warnCount >= 1)).toBe(true);
});

test('real rows never get a fabricated batch number', () => {
  const rows = mapRunsToEpisodes([run({ run_id: 'x' })]);
  expect(rows[0]?.batch).toBe('—');
});

test('quality/task mocking is deterministic across calls (same run id -> same values)', () => {
  const runs = [run({ run_id: 'stable-id' })];
  const first = mapRunsToEpisodes(runs)[0];
  const second = mapRunsToEpisodes(runs)[0];
  expect(second).toEqual(first);
});

test('duration falls back to started/ended span when duration_ms is absent', () => {
  const rows = mapRunsToEpisodes([
    run({ run_id: 'x', started_at: '2026-07-13T09:00:00Z', ended_at: '2026-07-13T09:00:05Z' }),
  ]);
  expect(rows[0]?.durationMs).toBe(5000);
});

test('FALLBACK_EPISODES is a non-empty, ep-descending-friendly demo set', () => {
  expect(FALLBACK_EPISODES.length).toBeGreaterThan(0);
  expect(new Set(FALLBACK_EPISODES.map((e) => e.runId)).size).toBe(FALLBACK_EPISODES.length);
});
