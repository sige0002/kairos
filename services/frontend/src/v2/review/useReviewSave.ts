// Saving a review (contract §4.1 + §12).
//
// `PATCH /captures/{id}/review` is a compare-and-swap: the client echoes the
// capture's current `review_revision` as `base_revision`, and the server
// refuses the write if anything moved underneath. That makes three outcomes
// meaningful, and this hook exists so every Review control handles all three
// the same way:
//
//   409 review_conflict  — someone saved first. Refetch and let the operator
//       re-apply. NEVER merge and never auto-retry: the whole point of the CAS
//       is that two terminals cannot silently overwrite each other, and a
//       client that retries with a fresh revision would defeat it.
//   409 capture_deleting — the delete won; the review is no longer changeable.
//   500 review_sidecar_write_failed — record.json could not be written, so
//       NOTHING was saved. §12 requires this to be stated explicitly: a quiet
//       failure here reads to the operator as a successful save, and they move
//       on believing a label exists that does not.
//
// Optimism is deliberately narrow. The UI applies the operator's change
// immediately (the table would feel broken otherwise) but reverts it on ANY
// failure, so the screen never shows a value the server rejected.

import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getCapture, saveReview } from '../../api/captures';
import { queryKeys } from '../../api/queryKeys';
import { readCaptureError, type CaptureErrorReading } from '../captures/errors';
import type { Capture, ReviewSaveRequest } from '../../api/types';

export interface ReviewConflict {
  captureId: string;
  /** The capture as it actually is now — refetched, so the banner can say what
   *  the other terminal decided rather than just that something clashed. */
  current: Capture | null;
  reading: CaptureErrorReading;
}

/** The outcome of one save. The error is RETURNED rather than only parked in
 *  the banner state, because a bulk caller needs the message for THIS capture
 *  and cannot read it back out of a hook field that the next iteration
 *  overwrites. */
export interface ReviewSaveResult {
  capture: Capture | null;
  error: CaptureErrorReading | null;
}

export interface SaveOptions {
  /** Skip the per-save cache invalidation. A bulk caller sets this and
   *  invalidates ONCE when the loop ends: invalidating per capture re-sweeps
   *  the whole catalog N times, which for a large batch is most of the work. */
  skipInvalidate?: boolean;
}

export interface ReviewSaveState {
  /** The unresolved conflict banner, or null. */
  conflict: ReviewConflict | null;
  dismissConflict: () => void;
  /** A failure the operator must acknowledge (the 500 sidecar case). */
  failure: CaptureErrorReading | null;
  dismissFailure: () => void;
  saving: boolean;
  /**
   * Save one capture's review. On failure the optimistic change must be
   * reverted by the caller — the result carries both the outcome and the
   * reading, so a bulk caller can report the real reason per capture.
   */
  save: (
    capture: Capture,
    changes: Omit<ReviewSaveRequest, 'base_revision'>,
    options?: SaveOptions,
  ) => Promise<ReviewSaveResult>;
  /** Invalidate the capture list once, after a bulk run that deferred it. */
  invalidateList: () => Promise<void>;
}

export function useReviewSave(scope: string): ReviewSaveState {
  const queryClient = useQueryClient();
  const [conflict, setConflict] = useState<ReviewConflict | null>(null);
  const [failure, setFailure] = useState<CaptureErrorReading | null>(null);
  const [saving, setSaving] = useState(false);

  const invalidateList = useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.captureList(scope) }),
    [queryClient, scope],
  );

  const save = useCallback(
    async (
      capture: Capture,
      changes: Omit<ReviewSaveRequest, 'base_revision'>,
      options: SaveOptions = {},
    ): Promise<ReviewSaveResult> => {
      setSaving(true);
      try {
        const updated = await saveReview(capture.capture_id, {
          ...changes,
          base_revision: capture.review_revision,
        });
        // A save that lands clears any banner the previous attempt raised.
        setConflict(null);
        setFailure(null);
        if (!options.skipInvalidate) await invalidateList();
        return { capture: updated, error: null };
      } catch (e) {
        const reading = readCaptureError(e, 'review');
        if (reading.reload) {
          // Refetch so the banner can state what is actually stored now. The
          // refetch is best-effort: if it also fails the conflict still stands,
          // and saying "someone else changed this" without the detail beats
          // saying nothing.
          let current: Capture | null = null;
          try {
            current = await getCapture(capture.capture_id);
          } catch {
            current = null;
          }
          setConflict({ captureId: capture.capture_id, current, reading });
        } else {
          setFailure(reading);
        }
        if (!options.skipInvalidate) await invalidateList();
        return { capture: null, error: reading };
      } finally {
        setSaving(false);
      }
    },
    [invalidateList],
  );

  return {
    conflict,
    dismissConflict: useCallback(() => setConflict(null), []),
    failure,
    dismissFailure: useCallback(() => setFailure(null), []),
    saving,
    save,
    invalidateList,
  };
}
