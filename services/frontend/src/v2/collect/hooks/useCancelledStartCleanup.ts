// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// What to do with a take the operator backed out of while it was still arming
// (#8).
//
// Cancel is local and immediate — the machine returns to READY the moment it is
// pressed — but the /record/start it cancels is already in flight, and the
// recorder honours it. The observed result was one start + one stop from a
// single gesture and a 0.05 s bag left in the catalog as `needs_review`: a take
// nobody meant to make, which an operator then has to recognise and remove by
// hand in Review.
//
// So the cancel path finishes the job it started: stop the recorder the
// cancelled start left running, then discard what it wrote. Three things about
// that sequence are load-bearing, and each is a bug that was found in review
// rather than a precaution:
//
//   1. THE STOP MUST NOT BE FIRED BLIND. `POST /record/stop` names no capture —
//      the orchestrator stops the newest non-terminal row — so a cancel whose
//      cleanup lands after another driver has started their own take would stop
//      THEIRS. A recording this screen is not driving is a modelled state (the
//      takeover card, D-1), not a hypothetical. The recorder is asked first,
//      and the stop is skipped when the live take is provably somebody else's.
//
//   2. THE DISCARD MUST OUTLAST THE DIGEST LEASE. `/record/stop` itself queues
//      the digest (record_service.py, `self._digest.schedule(capture_id)`),
//      which takes a 15-minute lease, and a leased capture answers a delete
//      with 409 `capture_busy` (captures.py `_reject_leased`). A discard sent
//      the millisecond the stop returns therefore loses a race it did not know
//      it was in, intermittently, leaving exactly the orphan this fix exists to
//      remove. The shared discard flow does not retry — deliberately, since its
//      other callers are operator-initiated and a refusal there is an answer —
//      so the retry lives here: bounded, only for `capture_busy`, and honest
//      when the budget runs out. Digesting a sub-second bag is quick; the
//      budget is sized for that, not for a real recording.
//
//   3. THE STOP MUST HAVE RETURNED BEFORE THE DISCARD IS SENT. A capture the
//      recorder still holds is refused, so firing both at once would just be
//      the race in (2) with worse odds.
//
// What this canNOT rely on: the server refusing to delete a capture that is
// still being written. `_reject_active` reads the capture ROW, and a stop that
// exhausted its budget commits the row as `interrupted` while the writer may
// still be alive — so the refusal is a backstop for the ordinary case, not a
// guarantee. That is why (1) and (3) are enforced here rather than left to it.
//
// One deliberate non-choice: the stop is not put through
// `confirmRecorderStopped`. That loop treats ANY active recorder state as "not
// stopped yet", and by the time this runs the operator is back at READY and may
// already have started the next take — which would hold the loop to its full
// budget and then report a stop failure that never happened.

import { useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { deleteCapture } from '../../../api/captures';
import { getRecordStatus, stopRecord } from '../../../api/record';
import { queryKeys } from '../../../api/queryKeys';
import {
  ACTIVE_RECORD_STATES,
  liveCaptureIds,
  type RecordStatus,
} from '../../../api/types';
import { captureErrorText, readCaptureError } from '../../captures/errors';
import { CANCELLED_START_DISCARD_REASON } from '../machine/types';
import { i18n } from '../../../i18n';

/** How long to keep re-offering a discard that is refused with `capture_busy`.
 *  The holder we expect is the digest the stop just queued, and the digest of a
 *  sub-second bag is a hash of a few hundred kB. Past this, the refusal is
 *  reported rather than waited out forever — a capture that is still busy after
 *  this long is being held by something that is not what we predicted, and
 *  saying so is more use than a spinner. */
const DISCARD_RETRY_MAX_MS = 12_000;
/** First backoff step; doubles up to DISCARD_RETRY_CAP_MS. */
const DISCARD_RETRY_BASE_MS = 250;
const DISCARD_RETRY_CAP_MS = 2000;

// Test seam, same shape as stopConfirm's and useCaptureDeletion's: the retry is
// a real wall-clock wait, which a unit test must not sit through.
let retryMaxMs: number | null = null;
let retryBaseMs: number | null = null;
export function __setDiscardRetryMs(maxMs: number, baseMs: number): void {
  retryMaxMs = maxMs;
  retryBaseMs = baseMs;
}
export function __resetDiscardRetryMs(): void {
  retryMaxMs = null;
  retryBaseMs = null;
}

/**
 * True only when the recorder POSITIVELY reports a live take that is not ours.
 *
 * Asymmetric on purpose. Skipping the stop is safe only on evidence; an
 * unreachable or unreadable recorder is not evidence, and treating it as such
 * would leave our own recorder running — the failure this cleanup exists to
 * prevent. So silence means "stop", and only a clear sighting of somebody
 * else's take means "don't".
 */
function isAnotherDriversTake(
  status: RecordStatus | null,
  captureId: string | null,
): boolean {
  if (!status || !captureId) return false;
  const live = liveCaptureIds(status);
  // The definitive list, when the recorder answered with one (§10 rev.2.4): a
  // live set that does not contain ours is somebody else's take.
  if (live) return live.length > 0 && !live.includes(captureId);
  // No live array — an unreachable recorder. `capture_id` alone is not a
  // liveness signal (it keeps pointing at the last take after a stop), so it
  // only counts alongside an active state.
  return (
    ACTIVE_RECORD_STATES.has(status.state) &&
    !!status.capture_id &&
    status.capture_id !== captureId
  );
}

export interface CancelledStartCleanup {
  /**
   * Stop and discard the capture a cancelled start produced.
   *
   * `captureId` is the id the start answered with — the capture THIS gesture
   * created. Resolves once the take is gone or the failure has been reported;
   * every outcome has reached the operator by then, on the toast if they are
   * still on Collect and on the unsaved-take banner if they are not.
   */
  reconcile: (captureId: string | null) => Promise<void>;
}

export function useCancelledStartCleanup({
  onToast,
}: {
  /** The screen's toast. The receipt and the failures land here. */
  onToast: (message: string) => void;
}): CancelledStartCleanup {
  const queryClient = useQueryClient();
  // Cleanups are serialised rather than dropped. The shared deletion hook
  // answers a second call while one is in flight with a silent `return` — fine
  // for a button an operator can press again, wrong here, where the second call
  // is the only thing that would ever remove the second orphan. Two cancels in
  // a row are rare but they are exactly the gesture this fix is about.
  const queue = useRef<Promise<void>>(Promise.resolve());

  const discardWithRetry = useCallback(
    async (captureId: string): Promise<unknown | null> => {
      const deadline = Date.now() + (retryMaxMs ?? DISCARD_RETRY_MAX_MS);
      let delay = retryBaseMs ?? DISCARD_RETRY_BASE_MS;
      for (;;) {
        try {
          await deleteCapture(captureId, {
            kind: 'discard',
            reason: CANCELLED_START_DISCARD_REASON,
          });
          return null;
        } catch (e) {
          // Only the lease is worth waiting out. Every other refusal is an
          // answer — `capture_in_dataset`, `delete_unavailable`, a 500 — and
          // re-sending it would just be the same answer, later.
          if (readCaptureError(e, 'delete').code !== 'capture_busy') return e;
          if (Date.now() + delay >= deadline) return e;
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay = Math.min(delay * 2, DISCARD_RETRY_CAP_MS);
        }
      }
    },
    [],
  );

  const run = useCallback(
    async (captureId: string | null) => {
      // Ask before stopping: the stop names no capture, so the only protection
      // against ending another driver's take is knowing whose take is live.
      const status = await getRecordStatus().catch(() => null);
      let stopFailed = false;
      if (isAnotherDriversTake(status, captureId)) {
        // Ours already ended (or never held the recorder) and somebody else is
        // recording. Leave their take alone and go straight to removing ours.
        stopFailed = false;
      } else {
        try {
          await stopRecord();
        } catch {
          // A failed stop does not mean the capture is unremovable, so the
          // discard below still runs; if it IS still being written, the refusal
          // says so rather than this deciding to stay quiet.
          stopFailed = true;
        }
      }

      if (!captureId) {
        // The recorder started something it never named, so there is nothing to
        // key a discard on. Say so instead of implying the cancel was clean.
        await queryClient.invalidateQueries({ queryKey: queryKeys.recordStatus });
        await queryClient.invalidateQueries({ queryKey: queryKeys.captures });
        onToast(
          stopFailed
            ? i18n.t('collect:cancelledStartStopUnanswered')
            : i18n.t('collect:cancelledStartUnnamedCapture'),
        );
        return;
      }

      const failure = await discardWithRetry(captureId);

      // Invalidated on EVERY outcome, and this is what makes a failure durable:
      // a take that could not be discarded is a completed capture with no
      // review, which is precisely what the unsaved-take banner scans for. The
      // toast below dies with the screen on a tab switch; the banner is
      // server-backed and meets the operator when they come back.
      await queryClient.invalidateQueries({ queryKey: queryKeys.recordStatus });
      await queryClient.invalidateQueries({ queryKey: queryKeys.captures });

      if (failure) {
        onToast(captureErrorText(failure, 'delete'));
        return;
      }
      onToast(i18n.t('collect:cancelledStartDiscarded'));
    },
    [discardWithRetry, onToast, queryClient],
  );

  const reconcile = useCallback(
    (captureId: string | null) => {
      // Chained, never overlapped: two cleanups racing would have the second's
      // stop land on nothing and its discard fight the first's digest.
      const next = queue.current.then(() => run(captureId));
      queue.current = next.catch(() => {});
      return next;
    },
    [run],
  );

  return { reconcile };
}
