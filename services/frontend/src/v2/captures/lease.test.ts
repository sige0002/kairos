import { expect, test } from 'vitest';
import { leaseBlockReason, liveLease } from './lease';
import type { Capture } from '../../api/types';

const NOW = Date.parse('2026-08-03T10:00:00Z');

function capture(over: Partial<Capture> = {}): Capture {
  return {
    capture_id: 'cap-1',
    state: 'completed',
    review_status: 'pending',
    review_revision: 0,
    ...over,
  };
}

test('a lease with a future expiry is held', () => {
  const hold = liveLease(
    capture({
      lease_owner: 'digest-job-7',
      lease_expires_at: '2026-08-03T10:00:30Z',
    }),
    NOW,
  );
  expect(hold).toEqual({ owner: 'digest-job-7', until: '2026-08-03T10:00:30Z' });
});

// An expired lease is not a lease — the store compares the expiry when
// acquiring, so a stale row must not disable a control the server would accept.
test('an expired lease is not a lease', () => {
  expect(
    liveLease(
      capture({
        lease_owner: 'digest-job-7',
        lease_expires_at: '2026-08-03T09:59:59Z',
      }),
      NOW,
    ),
  ).toBeNull();
});

test('no owner means no lease, whatever the expiry says', () => {
  expect(liveLease(capture(), NOW)).toBeNull();
  expect(
    liveLease(capture({ lease_expires_at: '2026-08-03T10:00:30Z' }), NOW),
  ).toBeNull();
  expect(liveLease(null, NOW)).toBeNull();
});

// We cannot show it has lapsed, and wrongly offering a control that then 409s
// is the worse of the two mistakes.
test('an owner with no expiry is treated as held', () => {
  const hold = liveLease(capture({ lease_owner: 'digest-job-7' }), NOW);
  expect(hold).toEqual({ owner: 'digest-job-7', until: null });
});

test('an unparseable expiry does not release the lease', () => {
  expect(
    liveLease(
      capture({ lease_owner: 'digest-job-7', lease_expires_at: 'not-a-date' }),
      NOW,
    ),
  ).not.toBeNull();
});

test('the reason names the holder, and the until clause is dropped when unknown', () => {
  // "try again later" is not actionable without saying what to wait for.
  expect(
    leaseBlockReason({ owner: 'digest-job-7', until: '2026-08-03T10:00:30Z' }),
  ).toMatch(/^digest-job-7 is working on this capture · until /);
  expect(leaseBlockReason({ owner: 'digest-job-7', until: null })).toBe(
    'digest-job-7 is working on this capture',
  );
  // A junk timestamp drops the clause rather than printing it.
  expect(leaseBlockReason({ owner: 'digest-job-7', until: 'not-a-date' })).toBe(
    'digest-job-7 is working on this capture',
  );
});
