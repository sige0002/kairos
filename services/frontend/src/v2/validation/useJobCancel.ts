// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Cancelling validation jobs.
//
// A job that is queued or running can be stopped; anything else has already
// reached its end and there is nothing to ask for. Cancels go one at a time so
// a refusal names the job it belongs to, and a refused one never stops the
// rest — the same rule every other bulk action here follows.
//
// A failed cancel is HELD, not toasted. The consequence of one is that a job
// the operator asked to stop is still running, and that is not something to let
// scroll away.

import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { cancelJob } from '../../api/jobs';
import { queryKeys } from '../../api/queryKeys';
import type { JobState } from '../../api/types';
import { captureErrorText } from '../captures/errors';

/** Only a job that has not reached an end can be cancelled. */
export function isCancellable(state: JobState | undefined): boolean {
  return state === 'queued' || state === 'running';
}

export interface JobCancel {
  /** Jobs with a cancel in flight, so their controls can stand down. */
  pending: ReadonlySet<string>;
  busy: boolean;
  /** The last refusal in the operator's words, held until dismissed. */
  error: string | null;
  cancel: (jobIds: string[]) => Promise<void>;
  dismissError: () => void;
}

export function useJobCancel(): JobCancel {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);

  const cancel = useCallback(
    async (jobIds: string[]) => {
      if (jobIds.length === 0) return;
      setError(null);
      setPending((prev) => new Set([...prev, ...jobIds]));
      const failed: string[] = [];
      let firstReason = '';
      for (const jobId of jobIds) {
        try {
          const job = await cancelJob(jobId);
          // Seed the status cache from the reply. A queued job comes back
          // `canceled` (terminal, poll stops). A RUNNING job comes back still
          // `running` with `cancel_requested` — the cancel is a request the
          // worker honours at its next checkpoint — so the poll keeps going
          // and the screen shows the true `canceled` when the work is dead.
          queryClient.setQueryData(queryKeys.job(jobId), job);
        } catch (e) {
          failed.push(jobId);
          if (!firstReason) firstReason = captureErrorText(e, 'job');
        } finally {
          setPending((prev) => {
            const next = new Set(prev);
            next.delete(jobId);
            return next;
          });
        }
      }
      if (failed.length > 0) {
        setError(
          failed.length === 1
            ? `Cancel failed — ${firstReason}`
            : `${failed.length} of ${jobIds.length} jobs could not be cancelled — ${firstReason}`,
        );
      }
    },
    [queryClient],
  );

  const dismissError = useCallback(() => setError(null), []);

  return { pending, busy: pending.size > 0, error, cancel, dismissError };
}
