import { expect, test } from 'vitest';
import { initialTransferSlot, transferReducer } from './transfer';

test('initialTransferSlot carries the server-seeded phase', () => {
  expect(initialTransferSlot('on_robot')).toEqual({ phase: 'on_robot' });
  expect(initialTransferSlot('transferred')).toEqual({ phase: 'transferred' });
});

test('START moves on_robot -> transferring, and only from on_robot', () => {
  expect(transferReducer(initialTransferSlot('on_robot'), { type: 'START' })).toEqual({
    phase: 'transferring',
  });
  // No-op on an in-flight or already-transferred slot (guards double-clicks
  // and "transfer all").
  const transferring = { phase: 'transferring' as const };
  expect(transferReducer(transferring, { type: 'START' })).toBe(transferring);
  const transferred = initialTransferSlot('transferred');
  expect(transferReducer(transferred, { type: 'START' })).toBe(transferred);
});

test('DONE (server confirmed bag_local) finalizes only an in-flight transfer', () => {
  expect(transferReducer({ phase: 'transferring' }, { type: 'DONE' })).toEqual({
    phase: 'transferred',
  });
  const onRobot = initialTransferSlot('on_robot');
  expect(transferReducer(onRobot, { type: 'DONE' })).toBe(onRobot);
});

test('FAIL (pull never queued) rolls an in-flight transfer back to on_robot', () => {
  expect(transferReducer({ phase: 'transferring' }, { type: 'FAIL' })).toEqual({
    phase: 'on_robot',
  });
  const transferred = initialTransferSlot('transferred');
  expect(transferReducer(transferred, { type: 'FAIL' })).toBe(transferred);
});
