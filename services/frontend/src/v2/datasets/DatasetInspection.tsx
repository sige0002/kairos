// Post-export inspection of the selected dataset — the v2-styled wrapper around
// the SHARED inspect pieces (src/features/inspect/inspect.tsx): the loss_report
// table, the on-demand video_check mp4 players, and the raw JSON sidecar blocks.
// These are REUSED as-is (never reimplemented): VideoPlayer carries the WebRTC
// MTU fixes' sibling job-polling logic and LossTable/JsonBlock the shared
// formatting. The jobs are keyed by the dataset's original run_id and read the
// moved MCAP via params.dataset_dir (detail.path).

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type { DatasetDetail, JobStatus } from '../../api/types';
import { ErrorMessage } from '../../components/ErrorMessage';
import {
  JsonBlock,
  LossTable,
  TERMINAL,
  VideoCheckSection,
} from '../../features/inspect/inspect';

export function DatasetInspection({ detail }: { detail: DatasetDetail }) {
  const queryClient = useQueryClient();
  const [lossJobId, setLossJobId] = useState<string | null>(null);
  const runId = detail.run_id ?? null;
  const detailKey = queryKeys.dataset(detail.operator, detail.task, detail.index);

  // Launch a loss_report job against the exported dir; poll to terminal, then
  // re-fetch the detail so detail.loss renders (same flow as v1 Recordings).
  const lossMutation = useMutation({
    mutationFn: () =>
      apiPost<JobStatus>('/jobs', {
        pipeline: 'loss_report',
        run_id: runId ?? '',
        params: { dataset_dir: detail.path },
      }),
    onSuccess: (job) => setLossJobId(job.job_id),
  });

  useQuery({
    queryKey: queryKeys.job(lossJobId ?? ''),
    queryFn: ({ signal }) =>
      apiGet<JobStatus>(`/jobs/${encodeURIComponent(lossJobId ?? '')}/status`, {
        signal,
      }),
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
            disabled={!runId || lossMutation.isPending || !!lossJobId}
            className="rounded-[9px] border border-teal-200 px-2.5 py-1 text-xs font-bold text-teal-700 hover:bg-teal-50 disabled:opacity-50"
          >
            {lossJobId
              ? 'Analyzing…'
              : lossMutation.isPending
                ? 'Starting…'
                : 'Run loss report'}
          </button>
        </div>
        {lossMutation.isError && <ErrorMessage error={lossMutation.error} />}
        {detail.loss?.topics ? (
          <LossTable topics={detail.loss.topics} />
        ) : (
          <p className="text-xs leading-relaxed text-gray-500">
            Per-topic loss rate (gap-based estimate) computed straight from the exported
            MCAP. Shortfalls are an observed estimate, not confirmed packet loss.
          </p>
        )}
      </section>

      {runId ? (
        <VideoCheckSection
          topics={detail.topics}
          runId={runId}
          datasetDir={detail.path}
        />
      ) : (
        <section>
          <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
            Video check
          </span>
          <p className="mt-1.5 text-xs text-gray-500">
            No run id on this dataset — camera previews need a source run to re-decode
            from.
          </p>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
          Sidecars
        </span>
        <JsonBlock label="Manifest" value={detail.manifest} />
        <JsonBlock label="Validation" value={detail.validation} />
        <JsonBlock label="Dataset json" value={detail.dataset} />
        {/* The labels that survived export (task result / quality / review
            status + batch context) — the file a training-set assembler reads. */}
        <JsonBlock label="Episode json" value={detail.episode} />
        {!detail.manifest &&
          !detail.validation &&
          !detail.dataset &&
          !detail.episode && (
            <p className="text-xs text-gray-500">
              No JSON sidecars present in this dataset.
            </p>
          )}
      </section>
    </div>
  );
}
