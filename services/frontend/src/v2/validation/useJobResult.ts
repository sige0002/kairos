// Poll a submitted job to a terminal state, then fetch its result. Same
// polling contract as features/validation/ValidationTab's `useJobResult`
// (that one isn't exported, so this mirrors it rather than importing an
// internal) — GET /jobs/{id}/status until terminal, then GET
// /jobs/{id}/result once.
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type { JobResult, JobStatus } from '../../api/types';

const TERMINAL = new Set(['succeeded', 'failed', 'canceled']);

export function useJobResult(jobId: string) {
  const statusQuery = useQuery({
    queryKey: queryKeys.job(jobId),
    queryFn: ({ signal }) =>
      apiGet<JobStatus>(`/jobs/${encodeURIComponent(jobId)}/status`, { signal }),
    refetchInterval: (q) => (q.state.data && TERMINAL.has(q.state.data.state) ? false : 1200),
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
