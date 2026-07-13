import { expect, test } from 'vitest';
import type { RunSummary } from '../../api/types';
import type { EpisodeOutcome } from '../episodeBridge';
import { mapRunsToEpisodes } from './mapRuns';

function run(overrides: Partial<RunSummary>): RunSummary {
  return { run_id: 'run_1', state: 'completed', ...overrides };
}

function outcome(overrides: Partial<EpisodeOutcome> = {}): EpisodeOutcome {
  return { quality: 'good', taskResult: 'ok', batchNum: 1, episodeIndex: 1, savedAt: 1, ...overrides };
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

// ---- Collect -> Review bridge (client-side, pre-Phase-2) -------------------

test('a completed run with a bridge outcome fills Quality / Task result / Batch', () => {
  const bridge: Record<string, EpisodeOutcome> = {
    withOutcome: outcome({ quality: 'review', taskResult: 'fail', batchNum: 4, episodeIndex: 9 }),
  };
  const rows = mapRunsToEpisodes(
    [run({ run_id: 'withOutcome' }), run({ run_id: 'noOutcome', started_at: '2026-07-13T10:00:00Z' })],
    (id) => bridge[id] ?? null,
  );
  const withO = rows.find((r) => r.runId === 'withOutcome');
  const without = rows.find((r) => r.runId === 'noOutcome');
  // Bridged row: Collect's axes mapped to the Review display vocabulary.
  expect(withO?.quality).toBe('Needs review');
  expect(withO?.task).toBe('Failure');
  expect(withO?.batch).toBe('4');
  // A run with no bridge entry stays honestly unset ("—" / null).
  expect(without?.quality).toBeNull();
  expect(without?.task).toBeNull();
  expect(without?.batch).toBe('—');
});

test('good/ok bridge outcome maps to Good / Success', () => {
  const rows = mapRunsToEpisodes([run({ run_id: 'x' })], () => outcome({ quality: 'good', taskResult: 'ok', batchNum: 2 }));
  expect(rows[0]?.quality).toBe('Good');
  expect(rows[0]?.task).toBe('Success');
  expect(rows[0]?.batch).toBe('2');
});

test('backend truth wins: a failed run stays "Not usable" even if a stale bridge entry exists', () => {
  const rows = mapRunsToEpisodes(
    [run({ run_id: 'gone-bad', state: 'failed' })],
    // A stale entry claiming Good must NOT override the real failure.
    () => outcome({ quality: 'good', taskResult: 'ok', batchNum: 5 }),
  );
  expect(rows[0]?.quality).toBe('Not usable');
  expect(rows[0]?.task).toBeNull();
  expect(rows[0]?.batch).toBe('—');
  expect(rows[0]?.issues).toBe('Recording did not complete cleanly');
});
