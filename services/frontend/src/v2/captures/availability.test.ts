// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
import { expect, test } from 'vitest';
import {
  availabilityFor,
  availabilityOf,
  isCaptureEmpty,
  isCapturePresent,
} from './availability';
import type { CaptureListItem, ReplicaState } from '../../api/types';

function capture(partial: Partial<CaptureListItem> = {}): CaptureListItem {
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

test('a verified copy holding nothing is amber, not an all-clear', () => {
  // Verification compares hashes against the manifest (§8, §9-4): an empty
  // recording passes it. A plain green "verified" there tells the operator the
  // recording is fine when there is nothing in it at all.
  const zeroBytes = availabilityOf(
    capture({ replica: { instance_id: 'i', state: 'present_verified' }, bytes: 0 }),
  );
  expect(zeroBytes.kind).toBe('verified_empty');
  expect(zeroBytes.tone).toBe('amber');
  expect(zeroBytes.warn).toBe(true);
  expect(zeroBytes.label).toBe('verified (empty)');
  expect(zeroBytes.detail).toMatch(/hashes/);
  expect(zeroBytes.detail).toMatch(/holds nothing/);

  // Zero messages is the same verdict whatever the bag weighs.
  const zeroMessages = availabilityOf(
    capture({
      replica: { instance_id: 'i', state: 'present_verified' },
      bytes: 4_096,
      message_count: 0,
    }),
  );
  expect(zeroMessages.kind).toBe('verified_empty');
  expect(zeroMessages.warn).toBe(true);
});

test('a verified copy with data in it is still the plain green verified', () => {
  const a = availabilityOf(
    capture({
      replica: { instance_id: 'i', state: 'present_verified' },
      bytes: 1_200_000,
      message_count: 1057,
    }),
  );
  expect(a.kind).toBe('verified');
  expect(a.tone).toBe('green');
  expect(a.warn).toBe(false);
});

test('an unreported size is unknown, never reported as empty', () => {
  // The honesty rule cuts both ways: a capture that reports no count has not
  // told us it is empty, and inventing that verdict is the same fabrication as
  // inventing a number.
  expect(isCaptureEmpty(capture({}))).toBe(false);
  expect(isCaptureEmpty(capture({ bytes: null, message_count: null }))).toBe(false);
  expect(
    availabilityOf(capture({ replica: { instance_id: 'i', state: 'present_verified' } })).kind,
  ).toBe('verified');
});

test('an empty capture that is not here reports where its bytes are, not its size', () => {
  // Emptiness is the LAST thing wrong with a copy that never arrived, vanished
  // or cannot be read — those states have not answered where the bytes are yet.
  expect(availabilityOf(capture({ replica: null, bytes: 0 })).kind).toBe('awaiting_transfer');
  expect(
    availabilityOf(
      capture({ replica: { instance_id: 'i', state: 'missing_unmanaged' }, bytes: 0 }),
    ).kind,
  ).toBe('missing');
  expect(
    availabilityOf(capture({ replica: { instance_id: 'i', state: 'corrupt' }, bytes: 0 })).kind,
  ).toBe('corrupt');
  // And a copy that is here but unhashed says so: it claims no verification to
  // undercut in the first place.
  expect(
    availabilityOf(
      capture({ replica: { instance_id: 'i', state: 'present_unverified' }, bytes: 0 }),
    ).kind,
  ).toBe('verifying');
});

test('availabilityFor stays usable without a capture, and is not empty by default', () => {
  // Callers holding only a replica state (§8 keeps the counts on the capture)
  // must still get a chip, and must not have emptiness guessed for them.
  expect(availabilityFor('present_verified', 'complete').kind).toBe('verified');
  expect(availabilityFor('present_verified', 'complete', true).kind).toBe('verified_empty');
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
