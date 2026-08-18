// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
import { expect, test } from 'vitest';
import type { RecordStatus } from '../../api/types';
import { readRecordStatus } from '../captures/useRecordStatus';
import { computeRecordContext, formatElapsed } from './recordContext';

const st = (partial: Partial<RecordStatus>): RecordStatus =>
  ({ run_id: null, state: 'created', live_capture_ids: [], ...partial }) as RecordStatus;

/** A reachable recorder that answered with this payload. */
const view = (partial: Partial<RecordStatus>) => readRecordStatus(st(partial));

test('computeRecordContext: recording → capture_id + run_id + elapsed from started_at', () => {
  const ctx = computeRecordContext(
    view({
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
    view({ state: 'stopping', run_id: 'run_9', capture_id: 'cap-9' }),
    1000,
  );
  expect(ctx.recording).toBe(true);
  expect(ctx.captureId).toBe('cap-9');
  expect(ctx.elapsedMs).toBeNull(); // no started_at → no baseline
});

test('computeRecordContext: created/completed/failed/absent → STANDBY', () => {
  for (const state of ['created', 'completed', 'failed'] as const) {
    expect(computeRecordContext(view({ state }), 1000).recording).toBe(false);
  }
  expect(computeRecordContext(readRecordStatus(undefined), 1000).recording).toBe(false);
});

// §10: the singular capture_id keeps naming the LAST capture after a stop, so it
// is not a liveness signal. Reading it without the live-state guard would leave
// the finished capture on screen as if it were still being written.
test('computeRecordContext: a finished capture is not carried over as the live one', () => {
  const ctx = computeRecordContext(
    view({
      state: 'completed',
      run_id: 'run_42',
      capture_id: 'cap-42',
      live_capture_ids: [],
    }),
    1000,
  );
  expect(ctx.recording).toBe(false);
  expect(ctx.captureId).toBeNull();
  expect(ctx.runId).toBeNull();
});

// §10 rev.2.4: an absent live_capture_ids array is an unreachable/too-old
// recorder, NOT an empty live set — the UI must be able to tell them apart.
test('computeRecordContext: liveKnown is false when the array is missing', () => {
  expect(computeRecordContext(view({ state: 'created' }), 0).liveKnown).toBe(true);
  expect(
    computeRecordContext(view({ state: 'recording', live_capture_ids: ['cap-1'] }), 0)
      .liveKnown,
  ).toBe(true);

  const noArray = readRecordStatus({ run_id: null, state: 'created' } as RecordStatus);
  expect(computeRecordContext(noArray, 0).liveKnown).toBe(false);
  expect(computeRecordContext(readRecordStatus(undefined), 0).liveKnown).toBe(false);
});

// B1: the recorder died mid-recording. react-query keeps serving the last
// successful response, so the payload still says `recording` — but a failed
// poll means nothing in it can be trusted, and the UI must stop claiming a
// recording is in progress rather than counting up from a dead session.
test('computeRecordContext: a failed poll retracts the recording claim', () => {
  const lastKnown = st({
    state: 'recording',
    run_id: 'run_42',
    capture_id: 'cap-42',
    live_capture_ids: ['cap-42'],
    started_at: '2026-07-13T15:00:00Z',
  });
  const stale = readRecordStatus(lastKnown, { failed: true });

  const ctx = computeRecordContext(stale, Date.parse('2026-07-13T15:10:00Z'));
  expect(ctx.recording).toBe(false);
  expect(ctx.captureId).toBeNull();
  expect(ctx.elapsedMs).toBeNull();
  // And it is NOT reported as a confirmed idle recorder either — we simply do
  // not know, which is the whole point.
  expect(ctx.liveKnown).toBe(false);
});

test('computeRecordContext: elapsed never goes negative if now precedes started_at', () => {
  const ctx = computeRecordContext(
    view({ state: 'recording', run_id: 'r', started_at: '2026-07-13T15:00:10Z' }),
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
