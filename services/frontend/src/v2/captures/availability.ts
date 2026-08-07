// Availability: what the UI is allowed to say about a capture's BYTES.
//
// Two facts combine (contract §8, §11): the local replica's state, and whether
// the digest job has sealed per-file hashes. They are kept separate on purpose —
// §9-4 forbids calling a copy verified before it has been verified — so this
// module is the one place that turns the pair into a single operator-facing
// phrase, and every screen reads it from here.
//
// The cases that must never be flattened:
//
//   * `null` replica is NOT "missing". A capture can hold review data with no
//     local copy at all: on a split deploy the operator reviews first and the
//     bytes are pulled afterwards. That is a normal state, not an error.
//   * `missing_unmanaged` is NOT a deletion. It is what an external `rm -rf`
//     produces, and §9-2 requires it to read as something that went wrong.
//   * `corrupt` is NOT absent. The sidecar is there and cannot be read (§8
//     rule 4); reporting it as "gone" would lose the only clue.
//   * `present_verified` is NOT automatically good news. Verification compares
//     per-file hashes against the manifest (§8, §9-4) — it says the copy is
//     intact, and says nothing about whether the recording holds anything. A
//     capture with zero bytes or zero messages passes it, and reading a plain
//     green "verified" there is how an empty recording gets shipped.

import type { CaptureListItem, DigestState, ReplicaState } from '../../api/types';
import type { Tone } from '../../components/ui';

export type AvailabilityKind =
  | 'verified'
  /** Verified, and there is nothing in it. A separate kind rather than a variant
   *  of `verified` so a breakdown that groups by kind cannot fold an empty
   *  recording into the green count. */
  | 'verified_empty'
  | 'verifying'
  | 'present'
  | 'trashed'
  | 'removed'
  | 'missing'
  | 'corrupt'
  | 'awaiting_transfer'
  | 'unknown';

export interface Availability {
  kind: AvailabilityKind;
  /** Chip text. Short enough for a table cell. */
  label: string;
  tone: Tone;
  /** The full explanation, shown as the chip's title/tooltip. */
  detail: string;
  /** True when the bytes are readable HERE right now — the precondition for
   *  running a job, playing a video, or archiving. */
  usable: boolean;
  /** True when this state is something the operator should look at. */
  warn: boolean;
}

const AWAITING_TRANSFER: Availability = {
  kind: 'awaiting_transfer',
  label: 'not here yet',
  tone: 'gray',
  detail:
    'No copy of this recording is on this machine yet. On a split deployment ' +
    'the bytes are pulled from the robot after the review — this is expected, ' +
    'not a failure.',
  usable: false,
  warn: false,
};

/**
 * True when the capture reports nothing in it.
 *
 * Either figure alone settles it: a bag of zero bytes has no data, and a bag
 * with zero messages has no data either whatever it weighs. An ABSENT figure is
 * not emptiness — an unreported count means unknown, and calling that empty
 * would be inventing the very fact the field is missing.
 */
export function isCaptureEmpty(capture: CaptureListItem): boolean {
  return capture.bytes === 0 || capture.message_count === 0;
}

/**
 * Resolve a capture's availability chip.
 *
 * `digest_state: 'pending'` on a present copy shows as "verifying": the bytes
 * are here and readable, but nothing has hashed them yet, so the UI says what
 * it actually knows rather than borrowing the verified badge early.
 */
export function availabilityOf(capture: CaptureListItem): Availability {
  const replica = capture.replica;
  if (!replica) return AWAITING_TRANSFER;
  return availabilityFor(
    replica.state,
    capture.digest_state ?? 'pending',
    isCaptureEmpty(capture),
  );
}

/**
 * The replica state as a chip, standalone.
 *
 * `empty` is the one fact this pair cannot carry: §8 keeps `message_count` /
 * `bytes` on the capture and the hashes on the replica, so a caller holding
 * only a replica state genuinely does not know whether the recording has
 * anything in it. It defaults to false — not empty until something says so.
 */
export function availabilityFor(
  state: ReplicaState,
  digestState: DigestState = 'pending',
  empty = false,
): Availability {
  switch (state) {
    case 'present_verified':
      // The emptiness is only consulted here. On any other replica state the
      // question of where the bytes are has not been answered yet, and that is
      // the more urgent thing to say — an empty capture that never reached this
      // host still reports its replica state, not its size.
      return empty
        ? {
            kind: 'verified_empty',
            label: 'verified (empty)',
            tone: 'amber',
            detail:
              'The copy on this machine is complete and its per-file hashes ' +
              'match the manifest — and the recording holds nothing: it ' +
              'reports zero bytes, or zero messages. Verification proves the ' +
              'copy is intact, not that there is anything in it, so this ' +
              'capture is verified and useless: nothing can be replayed, ' +
              'validated or trained from it.',
            usable: true,
            warn: true,
          }
        : {
            kind: 'verified',
            label: 'verified',
            tone: 'green',
            detail:
              'The copy on this machine is complete and its per-file hashes ' +
              'match the manifest.',
            usable: true,
            warn: false,
          };
    case 'present_unverified':
      return digestState === 'pending'
        ? {
            kind: 'verifying',
            label: 'verifying',
            tone: 'teal',
            detail:
              'The recording is on this machine and readable. Per-file hashes ' +
              'are still being computed, so it is not yet verified.',
            usable: true,
            warn: false,
          }
        : {
            kind: 'present',
            label: 'here',
            tone: 'teal',
            detail: 'The recording is on this machine and readable.',
            usable: true,
            warn: false,
          };
    case 'trashed':
      return {
        kind: 'trashed',
        label: 'in trash',
        tone: 'amber',
        detail:
          'This recording has been moved to the trash and is waiting to be ' +
          'removed from disk. It cannot be restored (§7 is one-way).',
        usable: false,
        warn: false,
      };
    case 'absent_managed':
      return {
        kind: 'removed',
        label: 'removed',
        tone: 'gray',
        detail:
          'The files were removed from this machine as part of a discard, a ' +
          'delete, or an archive. The record of the capture is kept.',
        usable: false,
        warn: false,
      };
    case 'missing_unmanaged':
      return {
        kind: 'missing',
        label: 'missing',
        tone: 'red',
        detail:
          'The files vanished from this machine without going through kairos ' +
          '— something deleted or unmounted them behind our back. Nothing was ' +
          'deleted on your behalf; check the storage before trusting the ' +
          'catalog.',
        usable: false,
        warn: true,
      };
    case 'corrupt':
      return {
        kind: 'corrupt',
        label: 'corrupt',
        tone: 'red',
        detail:
          'This capture exists on disk but its manifest cannot be read. It is ' +
          'reported rather than skipped, so it does not silently disappear ' +
          'from the catalog.',
        usable: false,
        warn: true,
      };
    default:
      // A replica state this build does not know — a newer server, or a value
      // added since. It must NOT fall through to "not here yet": that reads as
      // benign and expected, and an unrecognised state is neither. Say plainly
      // that we cannot vouch for the copy and flag it for a look.
      return {
        kind: 'unknown',
        label: 'unknown',
        tone: 'amber',
        detail:
          `The server reported a replica state this console does not recognise ` +
          `("${state}"). It may be running a newer version — treat the location ` +
          'of these bytes as unconfirmed until it is checked.',
        usable: false,
        warn: true,
      };
  }
}

/** True when a capture's bytes are readable on this host — the precondition
 *  every job, video preview and archive shares. */
export function isCapturePresent(capture: CaptureListItem): boolean {
  return availabilityOf(capture).usable;
}

/** True when the capture is on its way out or already gone (§7 tombstone).
 *  A screen holding one must stop offering live controls for it: the bytes are
 *  going or gone, and every action would be refused. */
export function isTombstoned(capture: CaptureListItem): boolean {
  return (
    capture.state === 'delete_pending' ||
    capture.state === 'discarded' ||
    capture.state === 'deleted'
  );
}
