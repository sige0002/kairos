// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
import { expect, test } from 'vitest';
import { initialTransferSlot, serverTransferPhase, transferReducer } from './transfer';
import type { CaptureListItem, ReplicaState } from '../../api/types';

function capture(replicaState: ReplicaState | null): CaptureListItem {
  return {
    capture_id: 'c1',
    state: 'completed',
    review_status: 'pending',
    review_revision: 0,
    replica: replicaState
      ? { instance_id: 'i1', state: replicaState }
      : null,
  };
}

test('serverTransferPhase claims "awaiting" only when no replica row exists', () => {
  expect(serverTransferPhase(capture(null))).toBe('awaiting');
});

test('serverTransferPhase never offers to pull a capture whose copy has a story', () => {
  // Every one of these is a KNOWN outcome for the copy — deliberately removed,
  // in the trash, deleted behind our back, or unreadable. Reporting them as
  // "awaiting" would offer a transfer that cannot be the right answer.
  const states: ReplicaState[] = [
    'present_verified',
    'present_unverified',
    'trashed',
    'absent_managed',
    'missing_unmanaged',
    'corrupt',
  ];
  for (const state of states) {
    expect(serverTransferPhase(capture(state))).toBe('here');
  }
});

test('initialTransferSlot carries the server-seeded phase', () => {
  expect(initialTransferSlot('awaiting')).toEqual({ phase: 'awaiting' });
  expect(initialTransferSlot('here')).toEqual({ phase: 'here' });
});

test('START moves awaiting -> transferring, and only from awaiting', () => {
  expect(transferReducer(initialTransferSlot('awaiting'), { type: 'START' })).toEqual({
    phase: 'transferring',
  });
  // No-op on an in-flight or already-arrived slot (guards double-clicks and
  // "transfer all").
  const transferring = { phase: 'transferring' as const };
  expect(transferReducer(transferring, { type: 'START' })).toBe(transferring);
  const here = initialTransferSlot('here');
  expect(transferReducer(here, { type: 'START' })).toBe(here);
});

test('DONE (the server reported a local replica) finalizes only an in-flight transfer', () => {
  expect(transferReducer({ phase: 'transferring' }, { type: 'DONE' })).toEqual({
    phase: 'here',
  });
  const awaiting = initialTransferSlot('awaiting');
  expect(transferReducer(awaiting, { type: 'DONE' })).toBe(awaiting);
});

test('FAIL (pull never queued) rolls an in-flight transfer back to awaiting', () => {
  expect(transferReducer({ phase: 'transferring' }, { type: 'FAIL' })).toEqual({
    phase: 'awaiting',
  });
  const here = initialTransferSlot('here');
  expect(transferReducer(here, { type: 'FAIL' })).toBe(here);
});
