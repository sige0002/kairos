// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Recovering an unreviewed capture must restore the batch it was recorded
// under. Current Collect context may belong to a later task or condition.

import { useCallback, useRef } from 'react';
import { getBatch } from '../../../api/batches';
import type { CaptureListItem } from '../../../api/types';
import { applyServerRestore, dispatch } from '../machine/store';

export function useUnsavedTakeRecovery({
  showToast,
}: {
  showToast: (message: string) => void;
}) {
  const recoveringCaptureId = useRef<string | null>(null);
  const recoveredBatch = useRef<{ captureId: string; batchId: string | null } | null>(
    null,
  );

  const resumeUnsavedTake = useCallback(
    async (capture: CaptureListItem): Promise<boolean> => {
      if (recoveringCaptureId.current === capture.capture_id) return false;
      recoveringCaptureId.current = capture.capture_id;
      const contextBatchId = capture.collection_context?.batch_id?.trim() || null;
      const originalBatchId = contextBatchId ?? capture.batch_id?.trim() ?? null;

      try {
        if (originalBatchId) {
          const batch = await getBatch(originalBatchId);
          // The detail, not the browser's current plan picker, is the durable
          // ownership record for this capture. It supplies its own sequence,
          // labels and monotonically recorded count before Save can proceed.
          applyServerRestore(batch, batch.captures);
        }
      } catch {
        // Do not open Result with a guessed current batch. The recovery banner
        // stays visible, so the operator can retry after the service recovers.
        recoveredBatch.current = null;
        showToast(
          'Could not restore this take’s original batch. It remains pending; retry Label it.',
        );
        return false;
      } finally {
        recoveringCaptureId.current = null;
      }

      // A null snapshot is an older/unlinked recovery, not permission to stamp
      // it onto whatever batch happens to be open after reload.
      recoveredBatch.current = {
        captureId: capture.capture_id,
        batchId: originalBatchId,
      };
      dispatch({
        type: 'RESUME_TAKE',
        captureId: capture.capture_id,
        runLabel: capture.run_id ?? null,
        reviewRevision: capture.review_revision,
      });
      return true;
    },
    [showToast],
  );

  const recoveredBatchIdForCapture = useCallback((captureId: string | null) => {
    if (!captureId || recoveredBatch.current?.captureId !== captureId) return undefined;
    return recoveredBatch.current.batchId;
  }, []);

  return { resumeUnsavedTake, recoveredBatchIdForCapture };
}
