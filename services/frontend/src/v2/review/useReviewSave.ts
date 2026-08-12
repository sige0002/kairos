// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
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

import { useCallback, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getCapture, saveReview } from '../../api/captures';
import { queryKeys } from '../../api/queryKeys';
import { readCaptureError, type CaptureErrorReading } from '../captures/errors';
import type { Capture, CaptureListItem, ReviewSaveRequest } from '../../api/types';

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
  /** Nothing was sent, because a save for this capture was already on the
   *  wire. Distinct from an error: no write was refused and nothing was lost —
   *  but nothing was written either, so a caller that counts outcomes must not
   *  count it as either a success or a failure. */
  skipped?: boolean;
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
  /** Which capture that failure is about. Moves with `failure` — both are
   *  read off one piece of state, so they cannot come apart. Null exactly
   *  when `failure` is null. */
  failureCaptureId: string | null;
  dismissFailure: () => void;
  /** Captures with a save on the wire, for rendering. State-backed, so it is
   *  one render behind the click that started the save. That is right for the
   *  screen and wrong for a gate — see `isSaving`. */
  savingCaptureIds: ReadonlySet<string>;
  /** The gate. Ref-backed, so it already answers true inside the tick the
   *  click happens in; `savingCaptureIds` does not, and gating on it would let
   *  a second submission through before React had committed. */
  isSaving: (captureId: string) => boolean;
  /**
   * Save one capture's review. On failure the optimistic change must be
   * reverted by the caller — the result carries both the outcome and the
   * reading, so a bulk caller can report the real reason per capture.
   *
   * At most one save per capture is on the wire at a time; a second is
   * refused here and returned as `skipped`. See the comment on the guard.
   */
  save: (
    capture: CaptureListItem,
    changes: Omit<ReviewSaveRequest, 'base_revision'>,
    options?: SaveOptions,
  ) => Promise<ReviewSaveResult>;
  /** Invalidate the capture list once, after a bulk run that deferred it. */
  invalidateList: () => Promise<void>;
}

export function useReviewSave(scope: string): ReviewSaveState {
  const queryClient = useQueryClient();
  const [conflict, setConflict] = useState<ReviewConflict | null>(null);
  // Held together with the capture it is about. A banner belongs to ONE
  // capture, and the pair has to travel as one value or the two halves drift.
  //
  // One slot, not a list. Two captures failing in turn means the second
  // displaces the first — reachable now that a banner outlives the selection.
  // Measured rather than argued: with both answering 500, the first capture is
  // left `pending` / NEEDS CHECK, quality unset, revision unmoved, and still
  // counted in the work queue. What is lost is the REASON, not the fact, so
  // this is display capacity rather than correctness. Pinned by
  // `a displaced failure notice loses the reason, not the fact` — if that ever
  // stops holding, the single-slot design has to be re-argued.
  const [failure, setFailure] = useState<{
    captureId: string;
    reading: CaptureErrorReading;
  } | null>(null);
  // The ref is the gate and the state is the picture of it. The state is
  // always a copy of the ref, so the two cannot disagree about WHAT is saving
  // — only about when, which is the whole reason both exist.
  const inFlight = useRef<Set<string>>(new Set());
  const [savingCaptureIds, setSavingCaptureIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const publishInFlight = useCallback(
    () => setSavingCaptureIds(new Set(inFlight.current)),
    [],
  );
  const isSaving = useCallback((captureId: string) => inFlight.current.has(captureId), []);

  const invalidateList = useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.captureList(scope) }),
    [queryClient, scope],
  );

  const save = useCallback(
    async (
      capture: CaptureListItem,
      changes: Omit<ReviewSaveRequest, 'base_revision'>,
      options: SaveOptions = {},
    ): Promise<ReviewSaveResult> => {
      const captureId = capture.capture_id;
      if (inFlight.current.has(captureId)) {
        // A save for this capture has not been answered yet, so the
        // `review_revision` carried here is the one that save already spent.
        // Sending it again cannot succeed — and the refusal would arrive as
        // `review_conflict`, which says "someone else saved a review for this
        // capture first" about the operator's own save. Whichever answer
        // landed last would then decide whether they were falsely accused or
        // told nothing at all. Neither is worth classifying: the honest thing
        // is not to send it.
        return { capture: null, error: null, skipped: true };
      }
      inFlight.current.add(captureId);
      publishInFlight();
      try {
        const updated = await saveReview(capture.capture_id, {
          ...changes,
          base_revision: capture.review_revision,
        });
        // A save that lands supersedes a banner about THIS capture: the
        // operator re-applied their decision and it took, so the banner is
        // describing something that is no longer true. It says nothing about
        // a DIFFERENT capture, whose refusal is still unaddressed and whose
        // stored value is still the other terminal's — clearing that one
        // would silence a real conflict on the strength of unrelated work.
        setConflict((cur) => (cur && cur.captureId !== captureId ? cur : null));
        setFailure((cur) => (cur && cur.captureId !== captureId ? cur : null));
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
          setFailure({ captureId, reading });
        }
        if (!options.skipInvalidate) await invalidateList();
        return { capture: null, error: reading };
      } finally {
        inFlight.current.delete(captureId);
        publishInFlight();
      }
    },
    [invalidateList, publishInFlight],
  );

  return {
    conflict,
    dismissConflict: useCallback(() => setConflict(null), []),
    failure: failure?.reading ?? null,
    failureCaptureId: failure?.captureId ?? null,
    dismissFailure: useCallback(() => setFailure(null), []),
    savingCaptureIds,
    isSaving,
    save,
    invalidateList,
  };
}
