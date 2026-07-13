import { expect, test } from 'vitest';
import type { RecordStatus } from '../../api/types';
import { computeRecordContext, formatElapsed } from './recordContext';

const st = (partial: Partial<RecordStatus>): RecordStatus =>
  ({ run_id: null, state: 'idle', ...partial }) as RecordStatus;

test('computeRecordContext: recording → run_id + elapsed from started_at', () => {
  const ctx = computeRecordContext(
    st({ state: 'recording', run_id: 'run_42', started_at: '2026-07-13T15:00:00Z' }),
    Date.parse('2026-07-13T15:00:05Z'),
  );
  expect(ctx.recording).toBe(true);
  expect(ctx.runId).toBe('run_42');
  expect(ctx.elapsedMs).toBe(5000);
});

test('computeRecordContext: stopping is still an active session', () => {
  const ctx = computeRecordContext(st({ state: 'stopping', run_id: 'run_9' }), 1000);
  expect(ctx.recording).toBe(true);
  expect(ctx.runId).toBe('run_9');
  expect(ctx.elapsedMs).toBeNull(); // no started_at → no baseline
});

test('computeRecordContext: created/completed/failed/undefined → STANDBY', () => {
  for (const state of ['created', 'completed', 'failed'] as const) {
    expect(computeRecordContext(st({ state }), 1000).recording).toBe(false);
  }
  expect(computeRecordContext(undefined, 1000).recording).toBe(false);
});

test('computeRecordContext: elapsed never goes negative if now precedes started_at', () => {
  const ctx = computeRecordContext(
    st({ state: 'recording', run_id: 'r', started_at: '2026-07-13T15:00:10Z' }),
    Date.parse('2026-07-13T15:00:00Z'),
  );
  expect(ctx.elapsedMs).toBe(0);
});

test('formatElapsed: HH:MM:SS, and em-dash when null', () => {
  expect(formatElapsed(0)).toBe('00:00:00');
  expect(formatElapsed(5000)).toBe('00:00:05');
  expect(formatElapsed(3661_000)).toBe('01:01:01');
  expect(formatElapsed(null)).toBe('—');
});
