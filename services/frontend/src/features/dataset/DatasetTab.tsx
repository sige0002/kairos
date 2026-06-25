// Dataset tab: dora_runner conversion outputs. The conversion pipeline is still
// an interface-only placeholder in dora_runner and there is no dataset-list API
// yet, so this does NOT invent a contract: it shows the (currently empty)
// "converted datasets" state honestly, and lists completed Runs as conversion
// sources — each can kick off the `dataset_convert` job via POST /api/v1/jobs.

import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { apiGet, apiPost } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type {
  JobStatus,
  Page,
  PipelineInfo,
  RunSummary,
} from '../../api/types';
import { ErrorMessage } from '../../components/ErrorMessage';
import { Badge, Button, Card, SectionLabel } from '../../components/ui';

const CONVERT_PIPELINE = 'dataset_convert';

function formatWhen(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function ConvertButton({ runId, enabled }: { runId: string; enabled: boolean }) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () =>
      apiPost<JobStatus>('/jobs', { pipeline: CONVERT_PIPELINE, run_id: runId }),
    onSuccess: (job) => {
      if (job.job_id) queryClient.setQueryData(queryKeys.job(job.job_id), job);
    },
  });
  return (
    <div className="flex flex-col gap-1">
      <Button
        type="button"
        onClick={() => mutation.mutate()}
        disabled={!enabled || mutation.isPending}
        className="px-3 py-1.5 text-xs"
      >
        {mutation.isPending
          ? '送信中…'
          : mutation.isSuccess
            ? '変換ジョブ作成済み'
            : '変換ジョブを作成'}
      </Button>
      {mutation.isError && <ErrorMessage error={mutation.error} />}
    </div>
  );
}

export function DatasetTab() {
  const runsQuery = useQuery({
    queryKey: queryKeys.runs(undefined),
    queryFn: ({ signal }) =>
      apiGet<Page<RunSummary>>('/runs', { signal, query: { limit: 50 } }),
    placeholderData: keepPreviousData,
  });

  const pipelinesQuery = useQuery({
    queryKey: queryKeys.pipelines,
    queryFn: ({ signal }) =>
      apiGet<PipelineInfo[] | { items: PipelineInfo[] }>('/pipelines', { signal }),
  });
  const pipelines: PipelineInfo[] = Array.isArray(pipelinesQuery.data)
    ? pipelinesQuery.data
    : (pipelinesQuery.data?.items ?? []);
  // The pipeline appears in the registry even as an interface-only placeholder
  // (enabled:false); only enable the action when the backend can actually run it.
  const convertAvailable = pipelines.some(
    (p) => p.id === CONVERT_PIPELINE && p.enabled === true,
  );

  const runs = (runsQuery.data?.items ?? []).filter((r) => r.state === 'completed');

  return (
    <div className="flex flex-col gap-[22px]">
      {/* Converted datasets — none yet (dora_runner conversion is a placeholder). */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <SectionLabel>変換済みデータセット</SectionLabel>
          <div className="flex-1" />
        </div>
        <Card className="p-8 text-center">
          <p className="text-sm font-medium text-gray-600">
            変換済みデータセットはまだありません
          </p>
          <p className="mx-auto mt-1.5 max-w-md text-xs text-gray-400">
            dora_runner の dataset 変換は現在プレースホルダ実装です。下の収録 Run から
            <span className="font-mono"> dataset_convert </span>
            ジョブを作成すると、変換出力（LeRobot / RLDS / MCAP）がここに並びます。
          </p>
        </Card>
      </section>

      {/* Conversion sources: completed recordings. */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <SectionLabel>変換元の Runs</SectionLabel>
          <span className="font-mono text-[11.5px] text-gray-400">
            {runs.length} completed
          </span>
          {!convertAvailable && pipelinesQuery.isSuccess && (
            <Badge tone="amber">dataset_convert 未実装（placeholder）</Badge>
          )}
        </div>

        {runsQuery.isError ? (
          <ErrorMessage error={runsQuery.error} />
        ) : runsQuery.isPending ? (
          <p className="text-sm text-gray-500">Loading runs…</p>
        ) : runs.length === 0 ? (
          <p className="text-sm text-gray-500">
            完了した収録がありません。Live タブで収録すると候補に並びます。
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-[18px] sm:grid-cols-2 lg:grid-cols-3">
            {runs.map((run) => (
              <Card key={run.run_id} className="flex flex-col gap-3 p-[18px]">
                <div className="flex items-start justify-between gap-2">
                  <span className="truncate font-mono text-sm font-semibold text-teal-700">
                    {run.run_id}
                  </span>
                  <Badge tone="gray" mono>
                    MCAP
                  </Badge>
                </div>
                <div className="grid grid-cols-2 gap-y-2 text-xs">
                  <div>
                    <div className="text-gray-400">収録日時</div>
                    <div className="mt-0.5 font-mono text-gray-700">
                      {formatWhen(run.started_at)}
                    </div>
                  </div>
                  <div>
                    <div className="text-gray-400">状態</div>
                    <div className="mt-0.5 font-mono text-gray-700">{run.state}</div>
                  </div>
                </div>
                <div className="flex-1" />
                <ConvertButton runId={run.run_id} enabled={convertAvailable} />
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
