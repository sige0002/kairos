// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Validation/conversion jobs.
//
// Submission and polling still happen at their call sites. `POST
// /jobs/{id}/cancel` answers with the job's new JobStatus, so the caller can
// seed its cache from the reply instead of waiting for the next poll to notice.

import { apiGet, apiPost, type RequestOptions } from './client';
import type { JobStatus } from './types';

/** Cancel a queued or running job. A queued job comes back `canceled`
 *  outright; a RUNNING one comes back still `running` with `cancel_requested`
 *  — the worker stops at its next checkpoint, and only then does the state
 *  turn `canceled`. Callers that need the work to be DEAD (a delete about to
 *  rename the capture) must keep polling until the state is terminal. */
export function cancelJob(jobId: string): Promise<JobStatus> {
  return apiPost<JobStatus>(`/jobs/${encodeURIComponent(jobId)}/cancel`, undefined);
}

export function getJobStatus(
  jobId: string,
  opts: RequestOptions = {},
): Promise<JobStatus> {
  return apiGet<JobStatus>(`/jobs/${encodeURIComponent(jobId)}/status`, opts);
}
