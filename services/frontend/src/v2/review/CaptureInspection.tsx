// Real per-capture inspection for the Review detail panel: fetches
// GET /captures/{id} and surfaces the recording facts (operator/task/timestamps/
// duration/message-count/size/topics), the on-demand video_check players, the
// loss_report table, a real fast_validation trigger, and the manifest /
// validation JSON sidecars.
//
// Nothing here is fabricated; missing data renders an honest "—". The sidecar
// fields are read best-effort from disk by the server, so a capture whose files
// are gone still returns cleanly and simply shows nothing for them.

import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../../api/client';
import { getCapture } from '../../api/captures';
import { queryKeys } from '../../api/queryKeys';
import type { ConfigOptions, JobStatus } from '../../api/types';
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
} from '../captures/inspect';
import { QuickCheckVerdict } from './QuickCheckVerdict';
import { SignalSection } from './SignalSection';
import { formatBytes } from './format';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-[11.5px] text-gray-400">{label}</dt>
      <dd className="text-[12.5px] text-gray-700">{children}</dd>
    </>
  );
}

// A dora_runner job started from this panel (loss_report / fast_validation):
// POST /jobs → poll status → on terminal, refetch the capture so its new
// sidecar (loss / validation) appears. Keyed by capture_id (§10.5); the job
// resolves its source as objects/<capture_id> and writes to
// report/<pipeline>/<capture_id>/.
function useCaptureJob(captureId: string, pipeline: string) {
  const queryClient = useQueryClient();
  const [jobId, setJobId] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: (params: Record<string, unknown>) =>
      apiPost<JobStatus>('/jobs', { pipeline, capture_id: captureId, params }),
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
        void queryClient.invalidateQueries({ queryKey: queryKeys.capture(captureId) });
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

export function CaptureInspection({ captureId }: { captureId: string }) {
  const detailQuery = useQuery({
    queryKey: queryKeys.capture(captureId),
    queryFn: ({ signal }) => getCapture(captureId, signal),
  });
  // The active validation template (config/options aspects.validation.active) —
  // fast_validation's required `template` param, resolved exactly as the
  // Validation screen does. No template ⇒ we can't submit an honest job.
  const optionsQuery = useQuery({
    queryKey: queryKeys.configOptions,
    queryFn: ({ signal }) => apiGet<ConfigOptions>('/config/options', { signal }),
  });
  const template = optionsQuery.data?.aspects?.validation?.active ?? '';

  const loss = useCaptureJob(captureId, 'loss_report');
  const validation = useCaptureJob(captureId, 'fast_validation');

  if (detailQuery.isPending)
    return <p className="text-[12.5px] text-gray-500">Loading capture…</p>;
  if (detailQuery.isError) return <ErrorMessage error={detailQuery.error} />;
  const capture = detailQuery.data;
  const completed = capture.state === 'completed';
  const topics = capture.topics ?? [];
  const validationResult =
    capture.validation && typeof capture.validation.result === 'string'
      ? (capture.validation.result as string)
      : null;

  return (
    <div data-testid="review-inspection" className="flex flex-col gap-3">
      {capture.error && (
        <p className="rounded-control bg-red-50 px-3 py-2 text-[12px] text-red-700">
          {capture.error.code}: {capture.error.message}
        </p>
      )}

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
        <Row label="State">{capture.state}</Row>
        {/* Both identities: run_id is what the operator recognises, capture_id
            is what every log line and API call uses. */}
        <Row label="Run">
          <span className="font-mono">{capture.run_id || '—'}</span>
        </Row>
        <Row label="Capture">
          <span className="font-mono text-[11.5px] text-gray-500">
            {capture.capture_id}
          </span>
        </Row>
        <Row label="Operator">{capture.operator || '—'}</Row>
        <Row label="Task">{capture.task || '—'}</Row>
        <Row label="Robot">{capture.robot || '—'}</Row>
        <Row label="Started">{formatWhen(capture.started_at)}</Row>
        <Row label="Ended">{formatWhen(capture.ended_at)}</Row>
        <Row label="Duration">
          {formatDuration(spanMs(capture.started_at, capture.ended_at)) || '—'}
        </Row>
        <Row label="Messages">
          {capture.message_count != null ? capture.message_count.toLocaleString() : '—'}
        </Row>
        <Row label="Size">{formatBytes(capture.bytes)}</Row>
        <Row label="Compression">{capture.compression || '—'}</Row>
      </dl>

      {/* Dataset membership is a property of the capture, so it is answerable
          here — and it is also what blocks a delete (§7), which makes it worth
          showing before the operator reaches for one. */}
      {(capture.memberships?.length ?? 0) > 0 && (
        <section data-testid="review-memberships">
          <h4 className="mb-1.5 text-[12.5px] font-medium text-gray-700">
            In {capture.memberships!.length} dataset
            {capture.memberships!.length === 1 ? '' : 's'}
          </h4>
          <ul className="rounded-control border border-gray-200 text-[11.5px]">
            {capture.memberships!.map((m) => (
              <li
                key={m.membership_id}
                className="flex items-center justify-between gap-2 border-t border-gray-100 px-2 py-1 first:border-t-0"
              >
                <span className="truncate text-gray-700">
                  {m.dataset_name ?? m.dataset_id}
                </span>
                <span className="shrink-0 font-mono text-gray-400">
                  #{m.display_index}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <QuickCheckVerdict quickCheck={capture.quick_check} />

      {completed ? (
        <VideoCheckSection topics={topics} captureId={captureId} />
      ) : (
        <p className="text-[12px] text-gray-500">
          Video preview is available once a recording completes.
        </p>
      )}

      {completed && <SignalSection captureId={captureId} topics={topics} />}

      <section>
        <h4 className="mb-1.5 text-[12.5px] font-medium text-gray-700">
          Topics ({topics.length})
        </h4>
        <ul
          data-testid="review-topics"
          className="max-h-40 overflow-auto rounded-control border border-gray-200 text-[11px]"
        >
          {topics.length === 0 ? (
            <li className="px-2 py-1 text-gray-400">No topics recorded.</li>
          ) : (
            topics.map((t) => (
              <li
                key={t.name}
                className="border-t border-gray-100 px-2 py-1 first:border-t-0"
              >
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
          {capture.loss?.topics ? (
            <LossTable topics={capture.loss.topics} />
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
            <h4 className="text-[12.5px] font-medium text-gray-700">
              Standard validation
            </h4>
            <div className="flex items-center gap-2">
              {validationResult && (
                <Badge
                  tone={
                    validationResult === 'pass'
                      ? 'green'
                      : validationResult === 'fail'
                        ? 'red'
                        : 'gray'
                  }
                  dot
                >
                  {validationResult.toUpperCase()}
                </Badge>
              )}
              <button
                type="button"
                data-testid="review-run-validation"
                onClick={() => template && validation.run({ template })}
                disabled={validation.running || !template}
                title={
                  template ? `template: ${template}` : 'No validation template configured'
                }
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
          {!capture.validation && template && (
            <p className="text-[11.5px] text-gray-500">
              Runs the <span className="font-mono">fast_validation</span> pipeline
              {` (${template})`} — checks the recording against the required topics.
            </p>
          )}
        </section>
      )}

      <section className="flex flex-col gap-1.5">
        <JsonBlock label="Manifest" value={capture.manifest} />
        <JsonBlock label="Record" value={capture.record} />
        <JsonBlock label="Validation" value={capture.validation} />
        {!capture.manifest && !capture.record && !capture.validation && (
          <p className="text-[11.5px] text-gray-500">
            No manifest / record / validation sidecars yet.
          </p>
        )}
      </section>
    </div>
  );
}
