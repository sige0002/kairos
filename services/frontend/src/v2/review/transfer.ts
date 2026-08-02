// Pure transfer state machine (awaiting -> transferring -> here), kept separate
// from useReviewState so the transitions are directly unit-testable.
//
// No fabricated progress. START only records that the pull request was sent;
// the ONLY completion signal is the server reporting a local replica for the
// capture, and FAIL rolls back a slot whose pull request never got queued
// (importer unreachable).
//
// The v1 `bag_local` boolean is gone (§10.6). It could say only "here" or "not
// here", and could not tell a copy that never arrived from one that was
// deliberately deleted — exactly the distinction an operator needs before
// deciding whether to pull again. Replica state carries that instead.

import { availabilityOf } from '../captures/availability';
import type { Capture } from '../../api/types';
import type { TransferPhase, TransferSlot } from './types';

/**
 * The phase the SERVER implies for a capture.
 *
 * `awaiting` is claimed only when there is no replica row at all — the honest
 * "this machine has never held it". Every other replica state means the copy's
 * story is known (present, trashed, deliberately removed, missing, corrupt) and
 * is told by the availability chip, so the transfer control must not offer to
 * pull something that is not simply absent.
 */
export function serverTransferPhase(capture: Capture): TransferPhase {
  return availabilityOf(capture).kind === 'awaiting_transfer' ? 'awaiting' : 'here';
}

export function initialTransferSlot(seed: TransferPhase): TransferSlot {
  return { phase: seed };
}

export type TransferAction = { type: 'START' } | { type: 'DONE' } | { type: 'FAIL' };

export function transferReducer(
  slot: TransferSlot,
  action: TransferAction,
): TransferSlot {
  switch (action.type) {
    case 'START':
      // Only a slot still awaiting its copy can start — a no-op on an in-flight
      // or already-arrived one (guards double-clicks and "transfer all").
      if (slot.phase !== 'awaiting') return slot;
      return { phase: 'transferring' };
    case 'DONE':
      if (slot.phase !== 'transferring') return slot;
      return { phase: 'here' };
    case 'FAIL':
      if (slot.phase !== 'transferring') return slot;
      return { phase: 'awaiting' };
    default:
      return slot;
  }
}
