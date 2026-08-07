import { afterEach, expect, test } from 'vitest';
import {
  __resetJobQueue,
  isGranted,
  releaseSlot,
  requestSlot,
  waitingAhead,
} from './jobQueue';

afterEach(() => __resetJobQueue());

test('the first request holds the capture; the rest wait in order', () => {
  const a = requestSlot('cap-1');
  const b = requestSlot('cap-1');
  const c = requestSlot('cap-1');

  expect(isGranted('cap-1', a)).toBe(true);
  expect(isGranted('cap-1', b)).toBe(false);
  expect(isGranted('cap-1', c)).toBe(false);
  expect(waitingAhead('cap-1', a)).toBe(0);
  expect(waitingAhead('cap-1', b)).toBe(1);
  expect(waitingAhead('cap-1', c)).toBe(2);
});

test('exactly one holder at every point of a full drain', () => {
  const tokens = [
    requestSlot('cap-1'),
    requestSlot('cap-1'),
    requestSlot('cap-1'),
    requestSlot('cap-1'),
    requestSlot('cap-1'),
  ];
  const holders = () => tokens.filter((t) => isGranted('cap-1', t)).length;

  // Five camera tiles, one capture — the case that produced 4×409.
  expect(holders()).toBe(1);
  for (const token of tokens) {
    expect(holders()).toBe(1);
    releaseSlot('cap-1', token);
  }
  expect(holders()).toBe(0);
});

// Holding the slot for a job that will never finish would strand every preview
// behind it, turning one broken topic into a section that never loads.
test('a failed job releases the capture to the next waiter', () => {
  const a = requestSlot('cap-1');
  const b = requestSlot('cap-1');

  releaseSlot('cap-1', a); // the job failed rather than succeeded
  expect(isGranted('cap-1', b)).toBe(true);
});

test('releasing a waiter that never held it promotes nobody', () => {
  const a = requestSlot('cap-1');
  const b = requestSlot('cap-1');
  const c = requestSlot('cap-1');

  // b unmounted while queued (the operator navigated away).
  releaseSlot('cap-1', b);
  expect(isGranted('cap-1', a)).toBe(true);
  expect(isGranted('cap-1', c)).toBe(false);
  expect(waitingAhead('cap-1', c)).toBe(1);
});

test('queues are per capture and do not block each other', () => {
  const a = requestSlot('cap-1');
  const b = requestSlot('cap-2');
  // The lease is per capture, so two captures run concurrently.
  expect(isGranted('cap-1', a)).toBe(true);
  expect(isGranted('cap-2', b)).toBe(true);
});

test('a released token is inert and cannot be released twice', () => {
  const a = requestSlot('cap-1');
  const b = requestSlot('cap-1');
  releaseSlot('cap-1', a);
  releaseSlot('cap-1', a); // idempotent — must not promote past b
  expect(isGranted('cap-1', b)).toBe(true);
  expect(waitingAhead('cap-1', b)).toBe(0);
});
