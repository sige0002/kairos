// Pure transfer state machine (on_robot -> transferring -> transferred). Kept
// separate from useReviewState's timers so the transition logic itself is
// directly unit-testable without fake timers.

import type { TransferPhase, TransferSlot } from './types';

export function initialTransferSlot(seed: TransferPhase): TransferSlot {
  return { phase: seed, pct: seed === 'transferred' ? 100 : 0 };
}

export type TransferAction =
  | { type: 'START' }
  | { type: 'TICK'; pct: number }
  | { type: 'DONE' };

export function transferReducer(slot: TransferSlot, action: TransferAction): TransferSlot {
  switch (action.type) {
    case 'START':
      // Only a slot still on the robot can start — no-op on an in-flight or
      // already-transferred one (guards double-clicks and "transfer all").
      if (slot.phase !== 'on_robot') return slot;
      return { phase: 'transferring', pct: 0 };
    case 'TICK':
      if (slot.phase !== 'transferring') return slot;
      return { phase: 'transferring', pct: Math.max(0, Math.min(99, action.pct)) };
    case 'DONE':
      if (slot.phase !== 'transferring') return slot;
      return { phase: 'transferred', pct: 100 };
    default:
      return slot;
  }
}

// Mock transfer pacing — Phase 1 has no real transfer channel to time against.
export const TRANSFER_DURATION_MS = 1800;
export const TRANSFER_TICK_MS = 150;
