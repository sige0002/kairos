// Pipelines tab (only mounted when enabled in config). Lists available
// pipelines (GET /api/v1/pipelines), renders a schema-driven form per pipeline
// from config.schemas.pipeline_forms, submits a job (POST /api/v1/jobs) and
// polls its status (GET /api/v1/jobs/{id}/status). SSE `job` events also write
// the same job query key, so polling and live updates coexist.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type { JobStatus, JobSubmitRequest, PipelineInfo } from '../../api/types';
import { ErrorMessage } from '../../components/ErrorMessage';
import { SchemaForm } from '../../components/SchemaForm';
import type { RuntimeConfig } from '../../config';

const TERMINAL_JOB_STATES = new Set(['succeeded', 'failed', 'canceled']);

function JobView({ jobId }: { jobId: string }) {
  const jobQuery = useQuery({
    queryKey: queryKeys.job(jobId),
    queryFn: ({ signal }) =>
      apiGet<JobStatus>(`/jobs/${encodeURIComponent(jobId)}/status`, { signal }),
    // Poll until terminal; SSE may update sooner via the same key.
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state && TERMINAL_JOB_STATES.has(state) ? false : 2000;
    },
  });

  if (jobQuery.isPending) return <p className="text-sm text-gray-500">Loading job…</p>;
  if (jobQuery.isError) return <ErrorMessage error={jobQuery.error} />;
  const job = jobQuery.data;

  return (
    <div className="rounded border p-3 text-sm">
      <p>
        <span className="font-mono">{job.job_id}</span> — {job.state}
        {job.progress !== undefined ? ` (${Math.round(job.progress * 100)}%)` : ''}
      </p>
      {job.logs_tail && job.logs_tail.length > 0 && (
        <pre className="mt-2 max-h-48 overflow-auto rounded bg-gray-50 p-2 text-xs">
          {job.logs_tail.join('\n')}
        </pre>
      )}
    </div>
  );
}

export function PipelinesTab({ config }: { config: RuntimeConfig }) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);

  const pipelinesQuery = useQuery({
    queryKey: queryKeys.pipelines,
    queryFn: ({ signal }) =>
      apiGet<PipelineInfo[] | { items: PipelineInfo[] }>('/pipelines', { signal }),
  });
  const pipelines: PipelineInfo[] = Array.isArray(pipelinesQuery.data)
    ? pipelinesQuery.data
    : (pipelinesQuery.data?.items ?? []);

  const submitMutation = useMutation({
    mutationFn: (body: JobSubmitRequest) => apiPost<JobStatus>('/jobs', body),
    onSuccess: (job) => {
      setJobId(job.job_id);
      queryClient.setQueryData(queryKeys.job(job.job_id), job);
    },
  });

  const forms = config.schemas.pipeline_forms ?? {};
  const selectedSchema = selected ? forms[selected] : undefined;

  return (
    <div className="flex flex-col gap-4">
      <section aria-label="pipelines">
        <h2 className="mb-2 font-semibold">Pipelines</h2>
        {pipelinesQuery.isError ? (
          <ErrorMessage error={pipelinesQuery.error} />
        ) : pipelinesQuery.isPending ? (
          <p className="text-sm text-gray-500">Loading pipelines…</p>
        ) : pipelines.length === 0 ? (
          <p className="text-sm text-gray-500">No pipelines available.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {pipelines.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  setSelected(p.id);
                  setJobId(null);
                }}
                aria-pressed={selected === p.id}
                className={`rounded border px-3 py-1 text-sm ${
                  selected === p.id ? 'bg-blue-50' : ''
                }`}
              >
                {p.name ?? p.id}
              </button>
            ))}
          </div>
        )}
      </section>

      {selected && (
        <section aria-label="pipeline form" className="rounded border p-3">
          <h3 className="mb-2 font-medium">{selected}</h3>
          {submitMutation.isError && <ErrorMessage error={submitMutation.error} />}
          {selectedSchema ? (
            <SchemaForm
              schema={selectedSchema}
              submitLabel={submitMutation.isPending ? 'Submitting…' : 'Run pipeline'}
              disabled={submitMutation.isPending}
              onSubmit={(params) =>
                submitMutation.mutate({ pipeline: selected, params })
              }
            />
          ) : (
            <SchemaForm
              schema={{ type: 'object', properties: {} }}
              submitLabel="Run pipeline"
              disabled={submitMutation.isPending}
              onSubmit={(params) =>
                submitMutation.mutate({ pipeline: selected, params })
              }
            />
          )}
        </section>
      )}

      {jobId && (
        <section aria-label="job status">
          <h3 className="mb-2 font-medium">Job</h3>
          <JobView jobId={jobId} />
        </section>
      )}
    </div>
  );
}
