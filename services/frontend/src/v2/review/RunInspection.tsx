// Real per-run inspection for the Review detail panel: fetches GET /runs/{id}
// and surfaces everything v1's RunsTab did — real operator/task/timestamps/
// duration/message-count/size/topics, the on-demand video_check players, the
// loss_report table, a real fast_validation trigger, and the manifest /
// validation / dataset-stats JSON sidecars. The heavy lifting (video mp4
// generation, loss table, JSON blocks) is imported from features/inspect and
// the job flows mirror v1 exactly — nothing here is fabricated; missing data
// renders an honest "—".

import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type { ConfigOptions, JobStatus, RunDetail } from '../../api/types';
import { Badge } from '../../components/ui';
import { ErrorMessage } from '../../components/ErrorMessage';
import {
  JsonBlock,
  LossTable,
  TERMINAL,
  VideoCheckSection,
  formatDuration,
  formatWhen,
  spanMs,
} from '../../features/inspect/inspect';

// The orchestrator's RunDetail also carries message_count/bytes (models.Run),
// which the shared api/types.ts RunDetail happens to omit — extend it locally
// rather than editing that shared type from this screen's directory.
type RunDetailFull = RunDetail & { message_count?: number | null; bytes?: number | null };

function runDurationMs(run: RunDetailFull): number | undefined {
  return spanMs(run.started_at, run.ended_at);
}

function formatBytes(bytes?: number | null): string {
  if (bytes === undefined || bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-[11.5px] text-gray-400">{label}</dt>
      <dd className="text-[12.5px] text-gray-700">{children}</dd>
    </>
  );
}

// A dora_runner job started from this panel (loss_report / fast_validation):
// POST /jobs → poll status → on terminal, refetch the run so its new sidecar
// (loss / validation) appears. Identical contract to v1's RunsTab loss flow.
function useRunJob(runId: string, pipeline: string) {
  const queryClient = useQueryClient();
  const [jobId, setJobId] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: (params: Record<string, unknown>) =>
      apiPost<JobStatus>('/jobs', { pipeline, run_id: runId, params }),
    onSuccess: (job) => setJobId(job.job_id),
  });
  useQuery({
    queryKey: queryKeys.job(jobId ?? ''),
    queryFn: ({ signal }) =>
      apiGet<JobStatus>(`/jobs/${encodeURIComponent(jobId ?? '')}/status`, { signal }),
    enabled: !!jobId,
    refetchInterval: (q) => {
      const state = q.state.data?.state;
      if (state && TERMINAL.has(state)) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.run(runId) });
        setJobId(null);
        return false;
      }
      return 1500;
    },
  });
  return {
    run: (params: Record<string, unknown>) => mutation.mutate(params),
    running: mutation.isPending || !!jobId,
    error: mutation.isError ? mutation.error : null,
  };
}

export function RunInspection({ runId }: { runId: string }) {
  const detailQuery = useQuery({
    queryKey: queryKeys.run(runId),
    queryFn: ({ signal }) => apiGet<RunDetailFull>(`/runs/${encodeURIComponent(runId)}`, { signal }),
  });
  // The active validation template (config/options aspects.validation.active) —
  // fast_validation's required `template` param, resolved exactly as the
  // Validation screen does. No template ⇒ we can't submit an honest job.
  const optionsQuery = useQuery({
    queryKey: queryKeys.configOptions,
    queryFn: ({ signal }) => apiGet<ConfigOptions>('/config/options', { signal }),
  });
  const template = optionsQuery.data?.aspects?.validation?.active ?? '';

  const loss = useRunJob(runId, 'loss_report');
  const validation = useRunJob(runId, 'fast_validation');

  if (detailQuery.isPending)
    return <p className="text-[12.5px] text-gray-500">Loading run…</p>;
  if (detailQuery.isError) return <ErrorMessage error={detailQuery.error} />;
  const run = detailQuery.data;
  const completed = run.state === 'completed';
  const validationResult =
    run.validation && typeof run.validation.result === 'string'
      ? (run.validation.result as string)
      : null;

  return (
    <div data-testid="review-inspection" className="flex flex-col gap-3">
      {run.error && (
        <p className="rounded-control bg-red-50 px-3 py-2 text-[12px] text-red-700">
          {run.error.code}: {run.error.message}
        </p>
      )}

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
        <Row label="State">{run.state}</Row>
        <Row label="Operator">{run.operator || '—'}</Row>
        <Row label="Task">{run.task || '—'}</Row>
        <Row label="Started">{formatWhen(run.started_at)}</Row>
        <Row label="Ended">{formatWhen(run.ended_at)}</Row>
        <Row label="Duration">{formatDuration(runDurationMs(run)) || '—'}</Row>
        <Row label="Messages">
          {run.message_count != null ? run.message_count.toLocaleString() : '—'}
        </Row>
        <Row label="Size">{formatBytes(run.bytes)}</Row>
        <Row label="Compression">{run.compression || '—'}</Row>
      </dl>

      {completed ? (
        <VideoCheckSection topics={run.topics} runId={runId} />
      ) : (
        <p className="text-[12px] text-gray-500">
          Video preview is available once a recording completes.
        </p>
      )}

      <section>
        <h4 className="mb-1.5 text-[12.5px] font-medium text-gray-700">
          Topics ({run.topics.length})
        </h4>
        <ul
          data-testid="review-topics"
          className="max-h-40 overflow-auto rounded-control border border-gray-200 text-[11px]"
        >
          {run.topics.length === 0 ? (
            <li className="px-2 py-1 text-gray-400">No topics recorded.</li>
          ) : (
            run.topics.map((t) => (
              <li key={t.name} className="border-t border-gray-100 px-2 py-1 first:border-t-0">
                <span className="font-mono text-gray-700">{t.name}</span>{' '}
                <span className="font-mono text-gray-400">{t.type}</span>
              </li>
            ))
          )}
        </ul>
      </section>

      {completed && (
        <section>
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <h4 className="text-[12.5px] font-medium text-gray-700">Loss report</h4>
            <button
              type="button"
              data-testid="review-run-loss"
              onClick={() => loss.run({})}
              disabled={loss.running}
              className="rounded-control border border-teal-200 px-2.5 py-1 text-[11.5px] font-semibold text-teal-700 transition-colors hover:bg-teal-50 disabled:opacity-50"
            >
              {loss.running ? 'Analyzing…' : 'Run loss report'}
            </button>
          </div>
          {loss.error && <ErrorMessage error={loss.error} />}
          {run.loss?.topics ? (
            <LossTable topics={run.loss.topics} />
          ) : (
            <p className="text-[11.5px] text-gray-500">
              Computes a per-topic loss estimate (gap-based).
            </p>
          )}
        </section>
      )}

      {completed && (
        <section>
          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-[12.5px] font-medium text-gray-700">Standard validation</h4>
            <div className="flex items-center gap-2">
              {validationResult && (
                <Badge tone={validationResult === 'pass' ? 'green' : validationResult === 'fail' ? 'red' : 'gray'} dot>
                  {validationResult.toUpperCase()}
                </Badge>
              )}
              <button
                type="button"
                data-testid="review-run-validation"
                onClick={() => template && validation.run({ template })}
                disabled={validation.running || !template}
                title={template ? `template: ${template}` : 'No validation template configured'}
                className="rounded-control border border-teal-200 px-2.5 py-1 text-[11.5px] font-semibold text-teal-700 transition-colors hover:bg-teal-50 disabled:opacity-50"
              >
                {validation.running ? 'Validating…' : 'Run validation'}
              </button>
            </div>
          </div>
          {validation.error && <ErrorMessage error={validation.error} />}
          {!template && !optionsQuery.isPending && (
            <p className="text-[11.5px] text-gray-500">
              No validation template is configured for the active robot.
            </p>
          )}
          {!run.validation && template && (
            <p className="text-[11.5px] text-gray-500">
              Runs the <span className="font-mono">fast_validation</span> pipeline
              {` (${template})`} — checks the recording against the required topics.
            </p>
          )}
        </section>
      )}

      <section className="flex flex-col gap-1.5">
        <JsonBlock label="Manifest" value={run.manifest} />
        <JsonBlock label="Validation" value={run.validation} />
        <JsonBlock label="Dataset stats" value={run.dataset_stats} />
        {!run.manifest && !run.validation && !run.dataset_stats && (
          <p className="text-[11.5px] text-gray-500">
            No manifest / validation / dataset sidecars yet.
          </p>
        )}
      </section>
    </div>
  );
}
