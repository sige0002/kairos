// Post-hoc inspection of the selected member's capture — the v2-styled wrapper
// around the SHARED inspect pieces (src/v2/captures/inspect.tsx): the
// loss_report table, the on-demand video_check mp4 players, and the raw JSON
// sidecar blocks. They are REUSED as-is rather than reimplemented, so a capture
// reads identically here and in Review.
//
// Every job is keyed by capture_id (§10.5). A job resolves its source as
// `objects/<capture_id>` whether or not the capture belongs to a dataset, which
// is why nothing about this panel changes when a membership is added or
// removed.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type { CaptureDetail, JobStatus, LossTopic } from '../../api/types';
import { ErrorMessage } from '../../components/ErrorMessage';
import { JsonBlock, LossTable, TERMINAL, VideoCheckSection } from '../captures/inspect';
import { isCapturePresent } from '../captures/availability';

/** The `loss` sidecar is a free-form dict on the wire; only its topic list is
 *  rendered, and only when it really is a list. */
function lossTopics(detail: CaptureDetail): LossTopic[] | null {
  const topics = detail.loss?.topics;
  return Array.isArray(topics) ? topics : null;
}

export function DatasetInspection({ detail }: { detail: CaptureDetail }) {
  const queryClient = useQueryClient();
  const [lossJobId, setLossJobId] = useState<string | null>(null);
  const captureId = detail.capture_id;
  const detailKey = queryKeys.capture(captureId);
  // A job reads objects/<capture_id>, so it cannot run against a capture whose
  // bytes are not on this host — a normal state for a dataset member (§12), not
  // an error, so the control explains itself instead of failing.
  const present = isCapturePresent(detail);

  // Launch a loss_report job; poll to terminal, then re-fetch the capture so
  // detail.loss renders.
  const lossMutation = useMutation({
    mutationFn: () =>
      apiPost<JobStatus>('/jobs', {
        pipeline: 'loss_report',
        capture_id: captureId,
        params: {},
      }),
    onSuccess: (job) => setLossJobId(job.job_id),
  });

  useQuery({
    queryKey: queryKeys.job(lossJobId ?? ''),
    queryFn: ({ signal }) =>
      apiGet<JobStatus>(`/jobs/${encodeURIComponent(lossJobId ?? '')}/status`, { signal }),
    enabled: !!lossJobId,
    refetchInterval: (q) => {
      const state = q.state.data?.state;
      if (state && TERMINAL.has(state)) {
        void queryClient.invalidateQueries({ queryKey: detailKey });
        setLossJobId(null);
        return false;
      }
      return 1500;
    },
  });

  const topics = lossTopics(detail);

  return (
    <div className="flex flex-col gap-4" data-testid="dataset-inspection">
      <section>
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
            Loss report
          </span>
          <button
            type="button"
            data-testid="run-loss-report-btn"
            onClick={() => lossMutation.mutate()}
            disabled={!present || lossMutation.isPending || !!lossJobId}
            title={
              present
                ? undefined
                : 'The recording is not readable on this machine, so there is nothing to analyze here.'
            }
            className="rounded-[9px] border border-teal-200 px-2.5 py-1 text-xs font-bold text-teal-700 hover:bg-teal-50 disabled:opacity-50"
          >
            {lossJobId ? 'Analyzing…' : lossMutation.isPending ? 'Starting…' : 'Run loss report'}
          </button>
        </div>
        {lossMutation.isError && <ErrorMessage error={lossMutation.error} />}
        {topics ? (
          <LossTable topics={topics} />
        ) : (
          <p className="text-xs leading-relaxed text-gray-500">
            Per-topic loss rate (gap-based estimate) computed straight from the MCAP.
            Shortfalls are an observed estimate, not confirmed packet loss.
          </p>
        )}
      </section>

      {present ? (
        <VideoCheckSection topics={detail.topics ?? []} captureId={captureId} />
      ) : (
        <section>
          <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
            Video check
          </span>
          <p className="mt-1.5 text-xs leading-relaxed text-gray-500">
            No readable copy of this recording on this machine, so there are no frames
            to decode. The membership is unaffected — a dataset may cite a capture
            whose bytes live elsewhere.
          </p>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
          Sidecars
        </span>
        <JsonBlock label="Object manifest" value={detail.manifest} />
        <JsonBlock label="Record (review)" value={detail.record} />
        <JsonBlock label="Validation" value={detail.validation} />
        {!detail.manifest && !detail.record && !detail.validation && (
          <p className="text-xs text-gray-500">No JSON sidecars present for this capture.</p>
        )}
      </section>
    </div>
  );
}
