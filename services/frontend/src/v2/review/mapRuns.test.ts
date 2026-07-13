import { expect, test } from 'vitest';
import type { RunSummary } from '../../api/types';
import { mapRunsToEpisodes } from './mapRuns';

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

test('a failed or interrupted run is the one real "Not usable" verdict', () => {
  const rows = mapRunsToEpisodes([
    run({ run_id: 'fail-1', state: 'failed' }),
    run({ run_id: 'fail-2', state: 'interrupted' }),
  ]);
  expect(rows.every((r) => r.quality === 'Not usable')).toBe(true);
  expect(rows.every((r) => r.issues === 'Recording did not complete cleanly')).toBe(true);
});

test('a clean (completed) run has NO fabricated quality/task/issues', () => {
  const rows = mapRunsToEpisodes([run({ run_id: 'x', state: 'completed' })]);
  expect(rows[0]?.quality).toBeNull();
  expect(rows[0]?.task).toBeNull();
  expect(rows[0]?.issues).toBeNull();
});

test('real rows never get a fabricated batch number', () => {
  const rows = mapRunsToEpisodes([run({ run_id: 'x' })]);
  expect(rows[0]?.batch).toBe('—');
});

test('carries the real run state and operator through', () => {
  const rows = mapRunsToEpisodes([
    run({ run_id: 'x', state: 'completed', operator: 'alice' }),
    run({ run_id: 'y', state: 'failed', operator: null, started_at: '2026-07-13T10:00:00Z' }),
  ]);
  const x = rows.find((r) => r.runId === 'x');
  const y = rows.find((r) => r.runId === 'y');
  expect(x?.state).toBe('completed');
  expect(x?.operator).toBe('alice');
  expect(y?.operator).toBeNull();
});

test('transfer seeds to on_robot (nothing transferred this session yet)', () => {
  const rows = mapRunsToEpisodes([run({ run_id: 'x' }), run({ run_id: 'y' })]);
  expect(rows.every((r) => r.transfer === 'on_robot')).toBe(true);
});

test('duration falls back to started/ended span when duration_ms is absent', () => {
  const rows = mapRunsToEpisodes([
    run({ run_id: 'x', started_at: '2026-07-13T09:00:00Z', ended_at: '2026-07-13T09:00:05Z' }),
  ]);
  expect(rows[0]?.durationMs).toBe(5000);
});
