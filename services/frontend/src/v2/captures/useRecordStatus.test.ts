// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
import { expect, test } from 'vitest';
import { readRecordStatus } from './useRecordStatus';
import type { RecordStatus } from '../../api/types';

const st = (partial: Partial<RecordStatus>): RecordStatus =>
  ({ run_id: null, state: 'created', live_capture_ids: [], ...partial }) as RecordStatus;

test('a reachable recorder that named an empty live set is a confirmed idle', () => {
  const v = readRecordStatus(st({ state: 'created', live_capture_ids: [] }));
  expect(v.reachable).toBe(true);
  expect(v.live).toEqual([]);
  expect(v.anyLive).toBe(false);
  expect(v.recording).toBe(false);
});

test('a recording session is both live and writing', () => {
  const v = readRecordStatus(
    st({ state: 'recording', capture_id: 'cap-1', live_capture_ids: ['cap-1'] }),
  );
  expect(v.anyLive).toBe(true);
  expect(v.recording).toBe(true);
  expect(v.captureId).toBe('cap-1');
});

// M3: armed is live (it holds subscriptions and appears in live_capture_ids per
// §10) but has written nothing. A surface that says "recording in progress" for
// it is lying about data that does not exist.
test('an armed session is live but is NOT recording', () => {
  const v = readRecordStatus(
    st({ state: 'armed', capture_id: 'cap-2', live_capture_ids: ['cap-2'] }),
  );
  expect(v.anyLive).toBe(true);
  expect(v.armed).toBe(true);
  expect(v.recording).toBe(false);
});

// §10 rev.2.4: an answer without the array is an unreachable or too-old
// recorder, not an empty live set.
test('a missing live_capture_ids array is "unknown", never "nothing is live"', () => {
  const v = readRecordStatus({ run_id: null, state: 'created' } as RecordStatus);
  expect(v.live).toBeNull();
  expect(v.anyLive).toBe(false);
  // Distinguishable from the confirmed-idle case above, which has live: [].
  expect(readRecordStatus(st({ live_capture_ids: [] })).live).toEqual([]);
});

// B1: the poll failed. react-query still serves the last successful payload, so
// everything in it reads as a live recording — but it describes a world that
// may be minutes gone.
test('a failed poll retracts every liveness claim the stale payload would support', () => {
  const lastKnown = st({
    state: 'recording',
    capture_id: 'cap-1',
    live_capture_ids: ['cap-1'],
  });
  const v = readRecordStatus(lastKnown, { failed: true });

  expect(v.reachable).toBe(false);
  expect(v.recording).toBe(false);
  expect(v.anyLive).toBe(false);
  expect(v.armed).toBe(false);
  expect(v.captureId).toBeNull();
  // `live` is null (unknown), NOT [] — we have not been told nothing is live.
  expect(v.live).toBeNull();
  // The payload is still reachable for anything that wants to show a
  // last-known value explicitly, but nothing derived from it asserts liveness.
  expect(v.status).toBe(lastKnown);
});

test('no response yet is loading, and claims nothing', () => {
  const v = readRecordStatus(undefined, { loading: true });
  expect(v.loading).toBe(true);
  expect(v.reachable).toBe(true); // nothing has failed; we simply have not asked
  expect(v.anyLive).toBe(false);
  expect(v.live).toBeNull();
});
