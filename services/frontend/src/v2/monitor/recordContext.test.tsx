import { expect, test } from 'vitest';
import type { RecordStatus } from '../../api/types';
import { computeRecordContext, formatElapsed } from './recordContext';

const st = (partial: Partial<RecordStatus>): RecordStatus =>
  ({ run_id: null, state: 'created', live_capture_ids: [], ...partial }) as RecordStatus;

test('computeRecordContext: recording → capture_id + run_id + elapsed from started_at', () => {
  const ctx = computeRecordContext(
    st({
      state: 'recording',
      run_id: 'run_42',
      capture_id: '0199aaaa-0000-7000-8000-000000000001',
      live_capture_ids: ['0199aaaa-0000-7000-8000-000000000001'],
      started_at: '2026-07-13T15:00:00Z',
    }),
    Date.parse('2026-07-13T15:00:05Z'),
  );
  expect(ctx.recording).toBe(true);
  expect(ctx.captureId).toBe('0199aaaa-0000-7000-8000-000000000001');
  expect(ctx.runId).toBe('run_42');
  expect(ctx.elapsedMs).toBe(5000);
});

test('computeRecordContext: stopping is still an active session', () => {
  const ctx = computeRecordContext(
    st({ state: 'stopping', run_id: 'run_9', capture_id: 'cap-9' }),
    1000,
  );
  expect(ctx.recording).toBe(true);
  expect(ctx.captureId).toBe('cap-9');
  expect(ctx.elapsedMs).toBeNull(); // no started_at → no baseline
});

test('computeRecordContext: idle/completed/failed/undefined → STANDBY', () => {
  for (const state of ['created', 'completed', 'failed'] as const) {
    expect(computeRecordContext(st({ state }), 1000).recording).toBe(false);
  }
  expect(computeRecordContext(undefined, 1000).recording).toBe(false);
});

// §10: the singular capture_id keeps naming the LAST capture after a stop, so it
// is not a liveness signal. Reading it without the live-state guard would leave
// the finished capture on screen as if it were still being written.
test('computeRecordContext: a finished capture is not carried over as the live one', () => {
  const ctx = computeRecordContext(
    st({ state: 'completed', run_id: 'run_42', capture_id: 'cap-42', live_capture_ids: [] }),
    1000,
  );
  expect(ctx.recording).toBe(false);
  expect(ctx.captureId).toBeNull();
  expect(ctx.runId).toBeNull();
});

// §10 rev.2.4: an absent live_capture_ids array is an unreachable/too-old
// recorder, NOT an empty live set — the UI must be able to tell them apart.
test('computeRecordContext: liveKnown is false only when the array is missing', () => {
  expect(computeRecordContext(st({ state: 'created', live_capture_ids: [] }), 0).liveKnown).toBe(true);
  expect(
    computeRecordContext(st({ state: 'recording', live_capture_ids: ['cap-1'] }), 0).liveKnown,
  ).toBe(true);

  const noArray = { run_id: null, state: 'created' } as RecordStatus;
  expect(computeRecordContext(noArray, 0).liveKnown).toBe(false);
  expect(computeRecordContext(undefined, 0).liveKnown).toBe(false);
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
