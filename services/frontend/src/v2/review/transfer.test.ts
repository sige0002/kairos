import { expect, test } from 'vitest';
import { initialTransferSlot, transferReducer } from './transfer';

test('initialTransferSlot seeds pct from the phase', () => {
  expect(initialTransferSlot('on_robot')).toEqual({ phase: 'on_robot', pct: 0 });
  expect(initialTransferSlot('transferred')).toEqual({ phase: 'transferred', pct: 100 });
});

test('START moves on_robot -> transferring at 0%', () => {
  const next = transferReducer(initialTransferSlot('on_robot'), { type: 'START' });
  expect(next).toEqual({ phase: 'transferring', pct: 0 });
});

test('START is a no-op once already transferring or transferred', () => {
  const transferring = { phase: 'transferring' as const, pct: 40 };
  expect(transferReducer(transferring, { type: 'START' })).toBe(transferring);
  const transferred = initialTransferSlot('transferred');
  expect(transferReducer(transferred, { type: 'START' })).toBe(transferred);
});

test('TICK only applies while transferring, and clamps to 0..99', () => {
  const onRobot = initialTransferSlot('on_robot');
  expect(transferReducer(onRobot, { type: 'TICK', pct: 50 })).toBe(onRobot);

  const transferring = { phase: 'transferring' as const, pct: 0 };
  expect(transferReducer(transferring, { type: 'TICK', pct: 150 }).pct).toBe(99);
  expect(transferReducer(transferring, { type: 'TICK', pct: -5 }).pct).toBe(0);
  expect(transferReducer(transferring, { type: 'TICK', pct: 42 })).toEqual({
    phase: 'transferring',
    pct: 42,
  });
});

test('DONE finalizes to transferred at 100%, only from transferring', () => {
  const transferring = { phase: 'transferring' as const, pct: 87 };
  expect(transferReducer(transferring, { type: 'DONE' })).toEqual({ phase: 'transferred', pct: 100 });

  const onRobot = initialTransferSlot('on_robot');
  expect(transferReducer(onRobot, { type: 'DONE' })).toBe(onRobot);
});
