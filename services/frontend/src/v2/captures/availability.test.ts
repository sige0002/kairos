import { expect, test } from 'vitest';
import { availabilityFor, availabilityOf, isCapturePresent } from './availability';
import type { Capture, ReplicaState } from '../../api/types';

function capture(partial: Partial<Capture> = {}): Capture {
  return {
    capture_id: 'c1',
    state: 'completed',
    review_status: 'pending',
    review_revision: 0,
    ...partial,
  };
}

test('no replica reads as "not here yet", never as missing', () => {
  // A capture can hold review data with no local copy: on a split deploy the
  // operator reviews first and the bytes are pulled afterwards (§12). Calling
  // that "missing" would report the intended order as a fault.
  const a = availabilityOf(capture({ replica: null }));
  expect(a.kind).toBe('awaiting_transfer');
  expect(a.warn).toBe(false);
  expect(a.usable).toBe(false);
});

test('a present copy with a pending digest reads as "verifying", not verified', () => {
  // §9-4 forbids promoting a copy to verified before it has been verified.
  const a = availabilityFor('present_unverified', 'pending');
  expect(a.kind).toBe('verifying');
  expect(a.label).toBe('verifying');
  expect(a.usable).toBe(true);
  expect(a.warn).toBe(false);
});

test('present_verified is the only state that claims verification', () => {
  expect(availabilityFor('present_verified', 'complete').kind).toBe('verified');
  expect(availabilityFor('present_unverified', 'complete').kind).not.toBe('verified');
});

test('missing_unmanaged and corrupt are warnings, not completed cleanups', () => {
  // §9-2: an external rm -rf is not a deletion. §8 rule 4: a corrupt sidecar is
  // never reported as absent. Both must reach the operator as something wrong.
  for (const state of ['missing_unmanaged', 'corrupt'] as ReplicaState[]) {
    const a = availabilityFor(state);
    expect(a.warn).toBe(true);
    expect(a.usable).toBe(false);
  }
});

test('a deliberate removal is not a warning', () => {
  // trashed / absent_managed are the outcomes of a discard, delete or archive —
  // the operator asked for them, so they are stated without alarm.
  for (const state of ['trashed', 'absent_managed'] as ReplicaState[]) {
    expect(availabilityFor(state).warn).toBe(false);
  }
});

test('only a present copy is usable — the precondition for jobs and playback', () => {
  expect(isCapturePresent(capture({ replica: { instance_id: 'i', state: 'present_verified' } }))).toBe(true);
  expect(isCapturePresent(capture({ replica: { instance_id: 'i', state: 'present_unverified' } }))).toBe(true);
  expect(isCapturePresent(capture({ replica: { instance_id: 'i', state: 'trashed' } }))).toBe(false);
  expect(isCapturePresent(capture({ replica: null }))).toBe(false);
});

test('every replica state produces a distinct, non-empty explanation', () => {
  // The chip's label is short by necessity, so the detail carries the meaning.
  // A duplicated detail would mean two different situations read identically.
  const states: ReplicaState[] = [
    'present_verified',
    'present_unverified',
    'trashed',
    'absent_managed',
    'missing_unmanaged',
    'corrupt',
  ];
  const details = states.map((s) => availabilityFor(s).detail);
  expect(new Set(details).size).toBe(states.length);
  for (const d of details) expect(d.length).toBeGreaterThan(0);
});

test('an unrecognised replica state is flagged, never softened into "not here yet"', () => {
  // A newer server, or a value added since this build. Falling through to the
  // awaiting-transfer wording would report an unknown as benign and expected.
  const a = availabilityFor('something_new' as ReplicaState);
  expect(a.kind).toBe('unknown');
  expect(a.warn).toBe(true);
  expect(a.usable).toBe(false);
  expect(a.detail).toContain('something_new');
});
