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
// So the cancel path finishes the job it started:
//
//   1. stop the recorder the cancelled start left running (best effort), and
//   2. discard what it wrote, through the SHARED §7 flow — same ledger entry,
//      same error voice, same cache invalidation as every other discard.
//
// The order is the whole point. A discard of a capture the recorder still holds
// is refused (`capture_recording`), so the stop must have RETURNED before the
// discard is sent — not merely been fired.
//
// Two deliberate non-choices:
//
//   * The stop is not put through `confirmRecorderStopped`. That loop treats
//     ANY active recorder state as "not stopped yet", and by the time this runs
//     the operator is back at READY and may already have started the next take
//     — which would hold the loop to its full budget and then report a stop
//     failure that never happened. The discard is capture-keyed, and the
//     server's refusal of a still-recording capture is the honest backstop.
//   * A failed stop does not skip the discard. The stop failing does not mean
//     the capture is unremovable, and if it IS still recording the refusal says
//     so on the toast rather than this deciding to stay quiet.

import { useCallback } from 'react';
import { stopRecord } from '../../../api/record';
import { queryKeys } from '../../../api/queryKeys';
import { useCaptureDeletion } from '../../captures/useCaptureDeletion';
import { CANCELLED_START_DISCARD_REASON } from '../machine/types';

export interface CancelledStartCleanup {
  /**
   * Stop and discard the capture a cancelled start produced.
   *
   * `captureId` is the id the start answered with — the capture THIS gesture
   * created. Resolves once both calls have been attempted; every outcome,
   * success or failure, has been reported on the toast by then.
   */
  reconcile: (captureId: string | null) => Promise<void>;
}

export function useCancelledStartCleanup({
  onToast,
}: {
  /** The screen's toast. Both the receipt and the failures land here. */
  onToast: (message: string) => void;
}): CancelledStartCleanup {
  // Its own deletion instance, like Collect's other two (episode / unsaved):
  // the flows are concurrent by nature and must not share a `busy` flag.
  // /record/status is invalidated alongside the capture list because the stop
  // below moved it.
  const discard = useCaptureDeletion({
    onToast,
    invalidate: [queryKeys.recordStatus],
  });

  const reconcile = useCallback(
    async (captureId: string | null) => {
      let stopFailed = false;
      try {
        await stopRecord();
      } catch {
        stopFailed = true;
      }
      if (!captureId) {
        // The recorder started something it never named, so there is nothing to
        // key a discard on. Say so instead of implying the cancel was clean.
        onToast(
          stopFailed
            ? 'Cancelled, but the recorder did not answer the stop — check Review for a leftover take'
            : 'Cancelled — the recorder had already started, but named no capture to remove',
        );
        return;
      }
      // discardNow reports its own failures on the toast (including a refusal
      // naming a recorder that is still running), so there is no silent path
      // out of here.
      await discard.discardNow(
        { capture_id: captureId },
        CANCELLED_START_DISCARD_REASON,
        'Cancelled — the take the recorder had begun was discarded',
      );
    },
    [discard, onToast],
  );

  return { reconcile };
}
