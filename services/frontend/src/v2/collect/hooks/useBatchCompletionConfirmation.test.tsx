// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki

import { act, renderHook } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { patchBatch } from '../../../api/batches';
import { useBatchCompletionConfirmation } from './useBatchCompletionConfirmation';

vi.mock('../../../api/batches', () => ({ patchBatch: vi.fn() }));

test('retry returns the review result accepted before batch completion failed', async () => {
  const patch = vi.mocked(patchBatch);
  patch.mockRejectedValueOnce(new Error('completion failed'));
  const { result } = renderHook(() => useBatchCompletionConfirmation());
  const accepted = {
    batchId: 'batch-1',
    index: 3,
    quality: 'review' as const,
    taskResult: 'fail' as const,
    failureReason: 'Grasp missed',
  };

  await act(async () => {
    await expect(result.current.confirm(accepted)).rejects.toThrow('completion failed');
  });
  expect(result.current.pendingCompletion).toEqual(accepted);

  patch.mockResolvedValueOnce({} as never);
  const confirmed = vi.fn();
  await act(async () => {
    await result.current.retry(confirmed);
  });

  expect(confirmed).toHaveBeenCalledWith(accepted);
});
