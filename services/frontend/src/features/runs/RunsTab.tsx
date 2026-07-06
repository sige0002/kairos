// Runs tab: cursor-paginated list (GET /api/v1/runs) on the left, detail view
// (GET /api/v1/runs/{id}) on the right with manifest JSON and validation /
// dataset stats when present. The inspection pieces (loss table, video check,
// JSON blocks) are shared with the Datasets tab via features/inspect.

import { useState } from 'react';
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { apiDelete, apiGet, apiPost } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type { JobStatus, Page, RunDetail, RunSummary } from '../../api/types';
import { ErrorMessage } from '../../components/ErrorMessage';
import {
  Badge,
  Button,
  Card,
  Modal,
  SectionLabel,
  TrashIcon,
  cn,
  type Tone,
} from '../../components/ui';
import {
  JsonBlock,
  LossTable,
  TERMINAL,
  VideoCheckSection,
  formatDuration,
  formatWhen,
  spanMs,
} from '../inspect/inspect';
import { useUiStore } from '../../store/uiStore';

/** A run's duration in ms: the backend `duration_ms` when present, otherwise
 *  derived from started_at/ended_at — the run-list payload omits duration_ms, so
 *  without this the list would never show a duration. */
function runDurationMs(run: {
  duration_ms?: number;
  started_at?: string;
  ended_at?: string | null;
}): number | undefined {
  if (run.duration_ms != null) return run.duration_ms;
  return spanMs(run.started_at, run.ended_at);
}

// Per-state badge tone for the recordings list — color-codes the run state at a
// glance (completed=green, failed=red, live=teal, stopping=amber, else neutral).
function stateTone(state: string): Tone {
  switch (state) {
    case 'completed':
      return 'green';
    case 'failed':
    case 'interrupted':
      return 'red';
    case 'recording':
      return 'teal';
    case 'stopping':
      return 'amber';
    default:
      return 'gray';
  }
}

function RunDetailView({
  runId,
  onRequestDelete,
  onValidate,
  onExport,
}: {
  runId: string;
  onRequestDelete: (runId: string) => void;
  onValidate: (runId: string) => void;
  onExport: (runId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [lossJobId, setLossJobId] = useState<string | null>(null);
  const detailQuery = useQuery({
    queryKey: queryKeys.run(runId),
    queryFn: ({ signal }) =>
      apiGet<RunDetail>(`/runs/${encodeURIComponent(runId)}`, { signal }),
  });

  // Launch a loss_report job for this run; remember its id to poll below.
  const lossMutation = useMutation({
    mutationFn: () =>
      apiPost<JobStatus>('/jobs', {
        pipeline: 'loss_report',
        run_id: runId,
        params: {},
      }),
    onSuccess: (job) => setLossJobId(job.job_id),
  });

  // Poll the loss job until terminal, then re-fetch the run so `loss` shows up.
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
        void queryClient.invalidateQueries({ queryKey: queryKeys.run(runId) });
        setLossJobId(null);
        return false;
      }
      return 1500;
    },
  });

  if (detailQuery.isPending)
    return <p className="text-sm text-gray-500">Loading run…</p>;
  if (detailQuery.isError) return <ErrorMessage error={detailQuery.error} />;
  const run = detailQuery.data;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-mono text-sm font-semibold text-teal-700">{run.run_id}</h3>
        <div className="flex items-center gap-2">
          {run.state === 'completed' && (
            <>
              <button
                type="button"
                onClick={() => onValidate(run.run_id)}
                className="rounded-control border border-teal-200 px-2.5 py-1 text-xs font-semibold text-teal-700 hover:bg-teal-50"
              >
                Validate
              </button>
              <button
                type="button"
                onClick={() => onExport(run.run_id)}
                className="rounded-control border border-teal-200 px-2.5 py-1 text-xs font-semibold text-teal-700 hover:bg-teal-50"
              >
                Export
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => onRequestDelete(run.run_id)}
            className="inline-flex items-center gap-1 rounded-control border border-red-200 px-2.5 py-1 text-xs font-semibold text-red-700 hover:bg-red-50"
          >
            <TrashIcon />
            Delete
          </button>
        </div>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-gray-500">State</dt>
        <dd>{run.state}</dd>
        <dt className="text-gray-500">Operator</dt>
        <dd>{run.operator || '—'}</dd>
        <dt className="text-gray-500">Task</dt>
        <dd>{run.task || '—'}</dd>
        <dt className="text-gray-500">Started</dt>
        <dd>{run.started_at ?? '—'}</dd>
        <dt className="text-gray-500">Ended</dt>
        <dd>{run.ended_at ?? '—'}</dd>
        <dt className="text-gray-500">Compression</dt>
        <dd>{run.compression ?? '—'}</dd>
      </dl>

      {run.error && (
        <p className="rounded-control bg-red-50 px-3 py-2 text-sm text-red-700">
          {run.error.code}: {run.error.message}
        </p>
      )}

      <section>
        <h4 className="mb-1.5 text-sm font-medium text-gray-700">
          Topics ({run.topics.length})
        </h4>
        <ul className="max-h-48 overflow-auto rounded-control border border-gray-200 text-xs">
          {run.topics.map((t) => (
            <li key={t.name} className="border-t border-gray-100 px-2 py-1 first:border-t-0">
              <span className="font-mono text-gray-700">{t.name}</span>{' '}
              <span className="font-mono text-gray-400">{t.type}</span>
            </li>
          ))}
        </ul>
      </section>

      {run.state === 'completed' && (
        <section>
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <h4 className="text-sm font-medium text-gray-700">Loss report</h4>
            <button
              type="button"
              onClick={() => lossMutation.mutate()}
              disabled={lossMutation.isPending || !!lossJobId}
              className="rounded-control border border-teal-200 px-2.5 py-1 text-xs font-semibold text-teal-700 hover:bg-teal-50 disabled:opacity-50"
            >
              {lossJobId
                ? 'Analyzing…'
                : lossMutation.isPending
                  ? 'Starting…'
                  : 'Run loss report'}
            </button>
          </div>
          {lossMutation.isError && <ErrorMessage error={lossMutation.error} />}
          {run.loss?.topics ? (
            <LossTable topics={run.loss.topics} />
          ) : (
            <p className="text-xs text-gray-500">
              Computes per-topic loss rate (gap-based estimate).
            </p>
          )}
        </section>
      )}

      {run.state === 'completed' && (
        <VideoCheckSection topics={run.topics} runId={runId} />
      )}

      <JsonBlock label="Manifest" value={run.manifest} />
      <JsonBlock label="Validation" value={run.validation} />
      <JsonBlock label="Dataset stats" value={run.dataset_stats} />
    </div>
  );
}

export function RunsTab() {
  const queryClient = useQueryClient();
  const setActiveTab = useUiStore((s) => s.setActiveTab);
  const setPendingRun = useUiStore((s) => s.setPendingRun);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [selected, setSelected] = useState<string | null>(null);
  // The run pending a delete-confirm modal (set from a row trash icon or the
  // detail Delete button); null hides the modal.
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const runsQuery = useQuery({
    queryKey: queryKeys.runs(cursor),
    queryFn: ({ signal }) =>
      apiGet<Page<RunSummary>>('/runs', { signal, query: { cursor, limit: 50 } }),
    placeholderData: keepPreviousData,
  });

  const deleteMutation = useMutation({
    mutationFn: (rid: string) => apiDelete(`/runs/${encodeURIComponent(rid)}`),
    onSuccess: (_data, rid) => {
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
      if (selected === rid) setSelected(null);
      setPendingDelete(null);
    },
  });

  // Deep-link to a sibling tab with the run preselected (Validate → Validation,
  // Export → Datasets), so the operator doesn't switch tab and re-find the run.
  function navigateToRun(tab: string, rid: string) {
    setPendingRun(rid);
    setActiveTab(tab);
  }

  return (
    <>
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <section aria-label="runs list" className="flex flex-col gap-2.5">
        <div>
          <h2 className="mb-1">
            <SectionLabel>Recordings</SectionLabel>
          </h2>
          <p className="text-xs text-gray-500">
            History of recordings (one MCAP per record start/stop):{' '}
            <span className="font-mono">/data/recorded/&lt;run_id&gt;</span>. Select one to
            view its topics, manifest, and validation / dataset results.
          </p>
        </div>
        {runsQuery.isError ? (
          <ErrorMessage error={runsQuery.error} />
        ) : runsQuery.isPending ? (
          <p className="text-sm text-gray-500">Loading runs…</p>
        ) : runsQuery.data.items.length === 0 ? (
          <p className="text-sm text-gray-500">No runs yet.</p>
        ) : (
          <ul
            className="overflow-hidden rounded-card border border-gray-200 bg-white shadow-card"
            role="list"
          >
            {runsQuery.data.items.map((run) => (
              <li
                key={run.run_id}
                className={cn(
                  'flex items-stretch border-t border-gray-100 transition-colors first:border-t-0',
                  selected === run.run_id ? 'bg-teal-50' : 'hover:bg-gray-50',
                )}
              >
                <button
                  type="button"
                  onClick={() => setSelected(run.run_id)}
                  aria-pressed={selected === run.run_id}
                  className="flex min-w-0 flex-1 items-center justify-between gap-2 px-3 py-2.5 text-left text-sm"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-mono text-teal-700">
                      {run.run_id}
                    </span>
                    <span className="font-mono text-xs text-gray-400">
                      {formatWhen(run.started_at)}
                      {runDurationMs(run) != null
                        ? ` · ${formatDuration(runDurationMs(run))}`
                        : ''}
                    </span>
                  </span>
                  <Badge tone={stateTone(run.state)} className="shrink-0">
                    {run.state}
                  </Badge>
                </button>
                <button
                  type="button"
                  aria-label="Delete recording"
                  title={`Delete ${run.run_id}`}
                  onClick={() => setPendingDelete(run.run_id)}
                  className="flex shrink-0 items-center px-3 text-gray-300 transition-colors hover:bg-red-50 hover:text-red-600"
                >
                  <TrashIcon />
                </button>
              </li>
            ))}
          </ul>
        )}

        {runsQuery.data?.next_cursor && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => setCursor(runsQuery.data.next_cursor ?? undefined)}
            className="self-start px-3 py-1"
          >
            Load more
          </Button>
        )}
      </section>

      <Card aria-label="run detail" className="p-[18px]">
        {selected ? (
          <RunDetailView
            runId={selected}
            onRequestDelete={setPendingDelete}
            onValidate={(rid) => navigateToRun('validation', rid)}
            onExport={(rid) => navigateToRun('dataset', rid)}
          />
        ) : (
          <p className="text-sm text-gray-500">Select a run to see details.</p>
        )}
      </Card>
    </div>

      <Modal
        open={!!pendingDelete}
        onClose={() => setPendingDelete(null)}
        title="Delete recording"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => setPendingDelete(null)}
              disabled={deleteMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => pendingDelete && deleteMutation.mutate(pendingDelete)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
            </Button>
          </>
        }
      >
        Permanently delete{' '}
        <span className="font-mono text-gray-800">{pendingDelete}</span>? This cannot be
        undone.
        {deleteMutation.isError && (
          <div className="mt-2">
            <ErrorMessage error={deleteMutation.error} />
          </div>
        )}
      </Modal>
    </>
  );
}
