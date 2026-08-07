// The capture lease (contract §7.1), read for the UI.
//
// A job takes the lease before touching `objects/<capture_id>`, and while it is
// held every other job — and every discard or delete — is refused with 409
// `capture_busy`. The capture row carries `lease_owner` and `lease_expires_at`,
// so a screen can know this BEFORE offering a control rather than letting the
// operator find out by pressing it and reading a rejection.
//
// This does not replace the 409 handling. A lease can be taken between the
// render and the click, so the refusal stays the race fallback; what this
// removes is the case where the answer was already on screen.

import type { CaptureListItem } from '../../api/types';

export interface LeaseHold {
  owner: string;
  /** ISO instant the lease lapses, or null when the row carries no expiry. */
  until: string | null;
}

/**
 * The lease currently held on this capture, or null.
 *
 * An EXPIRED lease is not a lease — the store compares the expiry when
 * acquiring, so a stale row must not disable a control the server would happily
 * accept. An owner with NO expiry is treated as held even though the SERVER
 * would not refuse it (its acquire and busy checks both treat a null expiry as
 * not-a-lease): we cannot show that it has lapsed, so this is a deliberate
 * fail-safe that is strictly more conservative than the server. The row state
 * is barely reachable — acquire always writes both columns together.
 */
export function liveLease(
  capture: CaptureListItem | null | undefined,
  nowMs: number = Date.now(),
): LeaseHold | null {
  const owner = capture?.lease_owner;
  if (!owner) return null;
  const until = capture?.lease_expires_at ?? null;
  if (until) {
    const expiresMs = Date.parse(until);
    if (!Number.isNaN(expiresMs) && expiresMs <= nowMs) return null;
  }
  return { owner, until };
}

/** Clock time from an ISO instant, for "until HH:MM:SS". Empty when the string
 *  is unusable, so the caller can drop the clause rather than print junk. */
function clockTime(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  return new Date(ms).toLocaleTimeString('en-GB', { hour12: false });
}

/**
 * Why a control is disabled, naming the holder.
 *
 * "Try again later" is not actionable without saying what to wait for, which is
 * exactly why the 409 payload carries `lease_owner` — the same reasoning
 * applies before the click.
 */
export function leaseBlockReason(hold: LeaseHold): string {
  const until = hold.until ? clockTime(hold.until) : '';
  return until
    ? `${hold.owner} is working on this capture · until ${until}`
    : `${hold.owner} is working on this capture`;
}
