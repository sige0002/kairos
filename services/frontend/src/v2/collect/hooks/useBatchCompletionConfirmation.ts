// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// A capture review has its own CAS acknowledgement. When it fills the final
// slot, the separate batch-completed PATCH must also succeed before Collect
// renders the completed state. This hook retains that second acknowledgement
// as a retryable receipt, avoiding an invalid second review CAS write.

import { useCallback, useState } from 'react';
import { patchBatch } from '../../../api/batches';
import type { Quality } from '../machine/types';

export interface PendingBatchCompletion {
  batchId: string;
  index: number;
  quality: Quality;
  taskResult: 'ok' | 'fail';
  failureReason: string;
}

export function useBatchCompletionConfirmation() {
  const [pendingCompletion, setPendingCompletion] =
    useState<PendingBatchCompletion | null>(null);

  const confirm = useCallback(async (completion: PendingBatchCompletion) => {
    try {
      await patchBatch(completion.batchId, { status: 'completed' });
    } catch (error) {
      setPendingCompletion(completion);
      throw error;
    }
  }, []);

  const retry = useCallback(
    async (onConfirmed: (completion: PendingBatchCompletion) => void) => {
      if (!pendingCompletion) return false;
      await patchBatch(pendingCompletion.batchId, { status: 'completed' });
      setPendingCompletion(null);
      onConfirmed(pendingCompletion);
      return true;
    },
    [pendingCompletion],
  );

  return { pendingCompletion, confirm, retry };
}
