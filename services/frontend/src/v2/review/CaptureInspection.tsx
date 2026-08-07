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
import { getConfigOptions } from '../../api/config';
import { getCapture } from '../../api/captures';
import { queryKeys } from '../../api/queryKeys';
import type { JobStatus,
  CaptureDetail,
} from '../../api/types';
import { Badge, cn } from '../../components/ui';
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
import { isTombstoned } from '../captures/availability';
import { readCaptureNote } from './captureNote';
import { leaseBlockReason, liveLease } from '../captures/lease';
import { JobErrorNote, isTombstoneError } from '../captures/JobErrorNote';
import { QuickCheckVerdict } from './QuickCheckVerdict';
import { SignalSection } from './SignalSection';
import { formatBytes } from './format';

/** How often an open capture detail re-reads itself. Slow enough to be
 *  invisible on a healthy screen, fast enough that a capture discarded
 *  elsewhere turns terminal on its own rather than on the operator's click. */
const DETAIL_REFRESH_MS = 10_000;

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
    onError: (error) => {
      // A 409 naming a tombstone is the news that this capture is gone —
      // usually discarded in another tab. Re-read it so the panel can stop
      // offering controls that can only be refused from here on.
      if (isTombstoneError(error)) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.capture(captureId) });
      }
    },
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

/** The validation verdict, and the override that can let a failure through.
 *
 *  The verdict is the server's derived one (from the gating pipelines'
 *  reports) — never a value this screen computes, so it cannot disagree with
 *  what the dataset gate will actually do. `unknown` is shown as its own state:
 *  reading "nothing has checked this" as a pass is the exact confusion this
 *  feature exists to end. */
function ValidationVerdict({ capture }: { capture: CaptureDetail }) {
  const queryClient = useQueryClient();
  const verdict = capture.verdict ?? null;
  const override = capture.validation_override ?? null;

  const overrideMutation = useMutation({
    mutationFn: (reason: string | null) =>
      apiPost<CaptureDetail>(`/captures/${capture.capture_id}/validation-override`, {
        reason,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.capture(capture.capture_id),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.captures });
    },
  });

  if (!verdict) return null; // older backend — say nothing rather than guess

  const tone =
    verdict === 'pass' ? 'green' : verdict === 'needs_review' ? 'red' : 'gray';
  const label =
    verdict === 'pass'
      ? 'VALIDATION PASSED'
      : verdict === 'needs_review'
        ? 'VALIDATION FAILED'
        : 'NOT VALIDATED';

  return (
    <section className="flex flex-col gap-1.5" data-testid="review-verdict">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={tone}>{label}</Badge>
        {verdict === 'unknown' && (
          <span className="text-[11.5px] text-gray-500">
            No gating validator has reported on this recording yet.
          </span>
        )}
        {override && (
          <span
            data-testid="review-verdict-override"
            className="text-[11.5px] text-amber-700"
          >
            Overridden: {override}
          </span>
        )}
      </div>
      {verdict === 'needs_review' && !override && (
        <div className="flex flex-col gap-1.5 rounded-control border border-red-200 bg-red-50 px-3 py-2.5">
          <span className="text-[12px] text-red-800">
            Datasets refuse this recording while validation says it is broken.
            Overriding is allowed — with a reason, which is kept in the ledger.
          </span>
          <button
            type="button"
            data-testid="review-verdict-override-btn"
            disabled={overrideMutation.isPending}
            onClick={() => {
              const reason = window.prompt(
                'Why should this recording be usable despite the failed validation?',
                '',
              );
              if (!reason || !reason.trim()) return;
              overrideMutation.mutate(reason.trim());
            }}
            className="self-start rounded-control border border-red-300 bg-white px-2.5 py-1 text-[11.5px] font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50"
          >
            Override with a reason…
          </button>
        </div>
      )}
      {override && (
        <button
          type="button"
          data-testid="review-verdict-override-clear"
          disabled={overrideMutation.isPending}
          onClick={() => overrideMutation.mutate(null)}
          className="self-start text-[11px] text-gray-400 hover:text-gray-600 disabled:opacity-50"
        >
          Withdraw the override
        </button>
      )}
    </section>
  );
}

/** The recorder's own account of a recording, coloured by what its code means
 *  rather than by the field being populated at all. */
function CaptureNote({ error }: { error: NonNullable<CaptureDetail['error']> }) {
  const note = readCaptureNote(error.code);
  return (
    <p
      data-testid="review-capture-error"
      data-error-code={error.code}
      data-severity={note.severity}
      className={cn(
        'rounded-control px-3 py-2 text-[12px]',
        note.severity === 'notice' ? 'bg-gray-50 text-gray-600' : 'bg-red-50 text-red-700',
      )}
    >
      {note.label && <span className="block font-medium">{note.label}</span>}
      {/* The fallback only speaks for a FAULT. A notice with no message would
       *  otherwise be told it failed — latent today (the one notice code always
       *  carries the recorder's sentence), and wrong the moment it is not. */}
      <span>
        {error.message || (note.severity === 'fault' ? 'This recording failed.' : '')}
      </span>
      {error.code && (
        <span className="mt-0.5 block font-mono text-[11px] opacity-70">
          ({error.code})
        </span>
      )}
    </p>
  );
}

export function CaptureInspection({ captureId }: { captureId: string }) {
  const detailQuery = useQuery({
    queryKey: queryKeys.capture(captureId),
    queryFn: ({ signal }) => getCapture(captureId, signal),
    // A capture can be discarded from another tab while this panel sits open.
    // Without a re-read the panel stayed live-looking — enabled buttons, a
    // reassuring QUICK CHECK — until the operator pressed something and got a
    // 409, which is finding out by being refused. The lease also changes
    // underneath (§7.1), so the controls' disabled state has the same need.
    refetchInterval: DETAIL_REFRESH_MS,
    refetchOnWindowFocus: true,
  });
  // The active validation template (config/options aspects.validation.active) —
  // fast_validation's required `template` param, resolved exactly as the
  // Validation screen does. No template ⇒ we can't submit an honest job.
  const optionsQuery = useQuery({
    queryKey: queryKeys.configOptions,
    queryFn: ({ signal }) => getConfigOptions({ signal }),
  });
  const template = optionsQuery.data?.aspects?.validation?.active ?? '';

  const loss = useCaptureJob(captureId, 'loss_report');
  const validation = useCaptureJob(captureId, 'fast_validation');

  if (detailQuery.isPending)
    return <p className="text-[12.5px] text-gray-500">Loading capture…</p>;
  if (detailQuery.isError) return <ErrorMessage error={detailQuery.error} />;
  const capture = detailQuery.data;
  const tombstoned = isTombstoned(capture);
  // §7.1: while a job holds the lease, every other job on this capture is
  // refused with 409 capture_busy. The row already says who holds it and until
  // when, so the operator learns it from the control instead of from a
  // rejection. The 409 handling stays as the race fallback — a lease can be
  // taken between this render and the click.
  const lease = liveLease(capture);
  const leaseReason = lease ? leaseBlockReason(lease) : null;
  // A tombstoned capture keeps its row (§7) but its bytes are going or gone, so
  // every job, preview and re-run below would be refused. Showing them live
  // invites an operator to keep pressing controls that cannot work — which is
  // exactly what happened when a discard in one tab left another tab's panel
  // fully interactive.
  const completed = capture.state === 'completed' && !tombstoned;
  const topics = capture.topics ?? [];
  const validationResult =
    capture.validation && typeof capture.validation.result === 'string'
      ? (capture.validation.result as string)
      : null;

  return (
    <div data-testid="review-inspection" className="flex flex-col gap-3">
      {tombstoned && (
        <div
          data-testid="review-capture-tombstoned"
          data-capture-state={capture.state}
          className="flex flex-col gap-1 rounded-control border border-amber-300 bg-amber-50 px-3 py-2.5 text-[12.5px] text-amber-900"
        >
          <span className="font-semibold">
            {capture.state === 'delete_pending'
              ? 'This recording is being removed.'
              : capture.delete_kind === 'discard'
                ? 'This recording was discarded.'
                : 'This recording was deleted.'}
          </span>
          <span>
            {capture.delete_reason
              ? `Reason given: ${capture.delete_reason}`
              : 'No reason was recorded.'}
            {capture.deleted_at ? ` · ${formatWhen(capture.deleted_at)}` : ''}
          </span>
          <span className="text-[11.5px] text-amber-800">
            Its details are kept so the record stays answerable, but nothing can
            be run against it any more.
          </span>
        </div>
      )}
      {capture.error && (
        // m9, same shape as the Collect banner: the sentence an operator can act
        // on leads, and the raw code trails it muted. "recorder_failed: recorder
        // restarted while the capture was recording" made the reader step over
        // an identifier to reach the only part that says what happened.
        //
        // No per-code copy table here on purpose. This is the recorder's own
        // account of THIS capture, written into the manifest — unlike an API
        // refusal (errors.ts) or a control action (ControlCard), there is no
        // next step for the UI to add, and inventing one would be a second
        // voice over the record.
        //
        // What the code DOES decide is severity (captureNote.ts): the manifest
        // field is the only one a recorder has, so it carries faults and
        // ordinary outcomes alike, and colouring by whether it is set at all
        // put a take that stopped where it was told into the red box.
        <CaptureNote error={capture.error} />
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

      {leaseReason && (
        <p
          data-testid="review-capture-busy"
          className="rounded-control border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-800"
        >
          {leaseReason}. Reports and previews can be run once it finishes.
        </p>
      )}

      <ValidationVerdict capture={capture} />

      <QuickCheckVerdict quickCheck={capture.quick_check} />

      {completed ? (
        <VideoCheckSection
          topics={topics}
          captureId={captureId}
          blockedReason={leaseReason}
        />
      ) : (
        <p className="text-[12px] text-gray-500">
          Video preview is available once a recording completes.
        </p>
      )}

      {completed && (
        <SignalSection
          captureId={captureId}
          topics={topics}
          blockedReason={leaseReason}
        />
      )}

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
              disabled={loss.running || !!leaseReason}
              title={leaseReason ?? undefined}
              className="rounded-control border border-teal-200 px-2.5 py-1 text-[11.5px] font-semibold text-teal-700 transition-colors hover:bg-teal-50 disabled:opacity-50"
            >
              {loss.running ? 'Analyzing…' : 'Run loss report'}
            </button>
          </div>
          <JobErrorNote error={loss.error} testId="review-loss-error" />
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
                disabled={validation.running || !template || !!leaseReason}
                title={
                  leaseReason ??
                  (template
                    ? `template: ${template}`
                    : 'No validation template configured')
                }
                className="rounded-control border border-teal-200 px-2.5 py-1 text-[11.5px] font-semibold text-teal-700 transition-colors hover:bg-teal-50 disabled:opacity-50"
              >
                {validation.running ? 'Validating…' : 'Run validation'}
              </button>
            </div>
          </div>
          <JobErrorNote error={validation.error} testId="review-validation-error" />
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
