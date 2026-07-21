// Pure transfer state machine (on_robot -> transferring -> transferred). Kept
// separate from useReviewState so the transition logic itself is directly
// unit-testable. No fabricated progress: START marks the pull request sent,
// the only DONE signal is the server's `bag_local` flipping true (the run's
// metadata.yaml landed locally — rsync writes it last), and FAIL rolls back a
// slot whose pull request never got queued (importer unreachable).

import type { TransferPhase, TransferSlot } from './types';

export function initialTransferSlot(seed: TransferPhase): TransferSlot {
  return { phase: seed };
}

export type TransferAction = { type: 'START' } | { type: 'DONE' } | { type: 'FAIL' };

export function transferReducer(slot: TransferSlot, action: TransferAction): TransferSlot {
  switch (action.type) {
    case 'START':
      // Only a slot still on the robot can start — no-op on an in-flight or
      // already-transferred one (guards double-clicks and "transfer all").
      if (slot.phase !== 'on_robot') return slot;
      return { phase: 'transferring' };
    case 'DONE':
      if (slot.phase !== 'transferring') return slot;
      return { phase: 'transferred' };
    case 'FAIL':
      if (slot.phase !== 'transferring') return slot;
      return { phase: 'on_robot' };
    default:
      return slot;
  }
}
