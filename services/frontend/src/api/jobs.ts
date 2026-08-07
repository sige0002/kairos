// Validation/conversion jobs.
//
// Cancel is the one call here for now; submission and polling still happen at
// their call sites. `POST /jobs/{id}/cancel` answers with the job's new
// JobStatus, so the caller can seed its cache from the reply instead of waiting
// for the next poll to notice.

import { apiPost } from './client';
import type { JobStatus } from './types';

/** Cancel a queued or running job. `canceled` is a terminal state — the job
 *  stops, and it is NOT a failure. */
export function cancelJob(jobId: string): Promise<JobStatus> {
  return apiPost<JobStatus>(`/jobs/${encodeURIComponent(jobId)}/cancel`, undefined);
}
