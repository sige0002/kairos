// Poll a submitted job to a terminal state, then fetch its result: GET
// /jobs/{id}/status until terminal, then GET /jobs/{id}/result once.
//
// The job is addressed by job_id alone. Its capture is already known to the
// caller that submitted it, and the artifacts the result names are already
// data-relative paths under `report/<pipeline>/<capture_id>/` (§10.5), so
// nothing here has to re-derive where the output lives.
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import { VALIDATION_JOB_POLL_MS } from '../pollingPolicy';
import type { JobResult, JobStatus } from '../../api/types';

const TERMINAL = new Set(['succeeded', 'failed', 'canceled']);

export function useJobResult(jobId: string) {
  const statusQuery = useQuery({
    queryKey: queryKeys.job(jobId),
    queryFn: ({ signal }) =>
      apiGet<JobStatus>(`/jobs/${encodeURIComponent(jobId)}/status`, { signal }),
    refetchInterval: (q) =>
      q.state.data && TERMINAL.has(q.state.data.state) ? false : VALIDATION_JOB_POLL_MS,
  });
  const terminal = !!statusQuery.data && TERMINAL.has(statusQuery.data.state);
  const resultQuery = useQuery({
    queryKey: queryKeys.jobResult(jobId),
    queryFn: ({ signal }) =>
      apiGet<JobResult>(`/jobs/${encodeURIComponent(jobId)}/result`, { signal }),
    enabled: terminal,
  });
  return { statusQuery, terminal, resultQuery };
}
