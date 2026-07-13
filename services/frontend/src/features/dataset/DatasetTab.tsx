// Dataset tab: export recordings into the tree, then browse exported datasets.
//
// Export (top): "Export all completed recordings" (POST /datasets/export-all)
// plus a per-completed-run "Export" button (POST /datasets/export).
// Datasets (below): GET /api/v1/datasets, grouped operator -> task -> [NNN];
// selecting a dataset opens the same inspection view as a recording
// (GET /datasets/{op}/{task}/{index}: metadata, topics, loss report, video
// check — the post-hoc jobs read the exported dir via the dataset_dir param).
// The detail pane offers Delete (DELETE /datasets/{op}/{task}/{index}) behind
// the same confirm modal as the Recordings delete.
// Export is a
// MOVE — the orchestrator runs the dataset_export job to completion
// synchronously, deletes the run row, and returns the summary. On any export
// success we invalidate both the runs list (so the exported run leaves the
// Recordings list) and the datasets list (so it appears under Datasets).

import { useEffect, useRef, useState } from 'react';
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { apiDelete, apiGet, apiPost } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import { useUiStore } from '../../store/uiStore';
import type {
  DatasetDetail,
  DatasetEntry,
  DatasetExportSummary,
  DatasetsResponse,
  ExportAllResponse,
  JobStatus,
  Page,
  RunSummary,
} from '../../api/types';
import { ErrorMessage } from '../../components/ErrorMessage';
import {
  Badge,
  Button,
  Card,
  Modal,
  SectionLabel,
  TrashIcon,
  cn,
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

function formatBytes(n?: number): string {
  if (n === undefined || n === null) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} kB`;
  return `${n} B`;
}

interface Grouped {
  operator: string;
  tasks: { task: string; entries: DatasetEntry[] }[];
}

/** Group the flat dataset list into operator -> task -> [entries]. */
function groupDatasets(datasets: DatasetEntry[]): Grouped[] {
  const byOperator = new Map<string, Map<string, DatasetEntry[]>>();
  for (const d of datasets) {
    let tasks = byOperator.get(d.operator);
    if (!tasks) {
      tasks = new Map();
      byOperator.set(d.operator, tasks);
    }
    const list = tasks.get(d.task) ?? [];
    list.push(d);
    tasks.set(d.task, list);
  }
  return [...byOperator.entries()].map(([operator, tasks]) => ({
    operator,
    tasks: [...tasks.entries()].map(([task, entries]) => ({ task, entries })),
  }));
}

function DatasetCard({
  entry,
  selected,
  onSelect,
}: {
  entry: DatasetEntry;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn('rounded-card text-left', selected && 'ring-2 ring-teal-400')}
    >
      <Card
        className={cn(
          'flex h-full flex-col gap-2 p-[14px] transition-colors',
          selected ? 'bg-teal-50' : 'hover:bg-gray-50',
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-sm font-semibold text-teal-700">
            #{entry.index}
          </span>
          <Badge tone="gray" mono>
            {formatBytes(entry.bytes)}
          </Badge>
        </div>
        <div
          className="break-all font-mono text-[11px] text-gray-500"
          data-testid="dataset-dir"
        >
          {entry.dataset_dir}
        </div>
        <div className="grid grid-cols-2 gap-y-1 text-[11px] text-gray-500">
          <div>Run: {entry.run_id ?? '—'}</div>
          <div>Exported: {formatWhen(entry.exported_at)}</div>
        </div>
      </Card>
    </button>
  );
}

// Detail pane for one exported dataset — the post-export twin of the
// Recordings detail view, backed by GET /datasets/{op}/{task}/{index}. The
// loss_report / video_check jobs stay keyed by the original run_id (from
// dataset.json) and read the moved MCAP via params.dataset_dir.
function DatasetDetailView({ entry }: { entry: DatasetEntry }) {
  const queryClient = useQueryClient();
  const [lossJobId, setLossJobId] = useState<string | null>(null);
  const detailKey = queryKeys.dataset(entry.operator, entry.task, entry.index);
  const detailQuery = useQuery({
    queryKey: detailKey,
    queryFn: ({ signal }) =>
      apiGet<DatasetDetail>(
        `/datasets/${encodeURIComponent(entry.operator)}/${encodeURIComponent(
          entry.task,
        )}/${encodeURIComponent(entry.index)}`,
        { signal },
      ),
  });
  const detail = detailQuery.data;
  const runId = detail?.run_id ?? null;

  // Launch a loss_report job against the exported dir; poll until terminal,
  // then re-fetch the detail so `loss` shows up (same flow as Recordings).
  const lossMutation = useMutation({
    mutationFn: () =>
      apiPost<JobStatus>('/jobs', {
        pipeline: 'loss_report',
        run_id: runId ?? '',
        params: { dataset_dir: detail?.path },
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

  if (detailQuery.isPending)
    return <p className="text-sm text-gray-500">Loading dataset…</p>;
  if (detailQuery.isError) return <ErrorMessage error={detailQuery.error} />;
  if (!detail) return null;

  const duration = spanMs(detail.started_at, detail.ended_at);

  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-gray-500">Run</dt>
        <dd className="font-mono">{detail.run_id ?? '—'}</dd>
        <dt className="text-gray-500">Started</dt>
        <dd>{detail.started_at ?? '—'}</dd>
        <dt className="text-gray-500">Ended</dt>
        <dd>{detail.ended_at ?? '—'}</dd>
        <dt className="text-gray-500">Duration</dt>
        <dd>{duration != null ? formatDuration(duration) : '—'}</dd>
        <dt className="text-gray-500">Messages</dt>
        <dd>{detail.message_count ?? '—'}</dd>
        <dt className="text-gray-500">Size</dt>
        <dd>{formatBytes(detail.bytes ?? undefined)}</dd>
        <dt className="text-gray-500">Exported</dt>
        <dd>{formatWhen(detail.exported_at)}</dd>
        <dt className="text-gray-500">Files</dt>
        <dd className="break-all font-mono text-xs">
          {detail.files.length > 0 ? detail.files.join(', ') : '—'}
        </dd>
      </dl>

      <section>
        <h4 className="mb-1.5 text-sm font-medium text-gray-700">
          Topics ({detail.topics.length})
        </h4>
        {detail.topics.length === 0 ? (
          <p className="text-xs text-gray-500">No topic list in the sidecars.</p>
        ) : (
          <ul className="max-h-48 overflow-auto rounded-control border border-gray-200 text-xs">
            {detail.topics.map((t) => (
              <li
                key={t.name}
                className="border-t border-gray-100 px-2 py-1 first:border-t-0"
              >
                <span className="font-mono text-gray-700">{t.name}</span>{' '}
                <span className="font-mono text-gray-400">{t.type}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <h4 className="text-sm font-medium text-gray-700">Loss report</h4>
          <button
            type="button"
            onClick={() => lossMutation.mutate()}
            disabled={!runId || lossMutation.isPending || !!lossJobId}
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
        {detail.loss?.topics ? (
          <LossTable topics={detail.loss.topics} />
        ) : (
          <p className="text-xs text-gray-500">
            Computes per-topic loss rate (gap-based estimate) from the exported MCAP.
          </p>
        )}
      </section>

      {runId && (
        <VideoCheckSection
          topics={detail.topics}
          runId={runId}
          datasetDir={detail.path}
        />
      )}

      <JsonBlock label="Manifest" value={detail.manifest} />
      <JsonBlock label="Validation" value={detail.validation} />
      <JsonBlock label="Dataset json" value={detail.dataset} />
    </div>
  );
}

function DatasetsSection() {
  const queryClient = useQueryClient();
  // The selected dataset (opens the detail pane on the right, like Recordings).
  const [selected, setSelected] = useState<DatasetEntry | null>(null);
  // Detail pane minimized to a slim bar: the tree gets the full width back
  // while the selection is kept, so expanding restores the same dataset.
  const [collapsed, setCollapsed] = useState(false);
  // The dataset pending a delete-confirm modal (set from the detail Delete
  // button); null hides the modal. Same UX as the Recordings delete.
  const [pendingDelete, setPendingDelete] = useState<DatasetEntry | null>(null);
  const datasetsQuery = useQuery({
    queryKey: queryKeys.datasets,
    queryFn: ({ signal }) => apiGet<DatasetsResponse>('/datasets', { signal }),
    placeholderData: keepPreviousData,
  });

  const deleteMutation = useMutation({
    mutationFn: (entry: DatasetEntry) =>
      apiDelete(
        `/datasets/${encodeURIComponent(entry.operator)}/${encodeURIComponent(
          entry.task,
        )}/${encodeURIComponent(entry.index)}`,
      ),
    onSuccess: (_data, entry) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.datasets });
      queryClient.removeQueries({
        queryKey: queryKeys.dataset(entry.operator, entry.task, entry.index),
      });
      if (selected?.dataset_dir === entry.dataset_dir) setSelected(null);
      setPendingDelete(null);
    },
  });

  const datasets = datasetsQuery.data?.datasets ?? [];
  const groups = groupDatasets(datasets);
  const showDetail = selected !== null && !collapsed;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <SectionLabel>Datasets</SectionLabel>
        <span className="font-mono text-[11.5px] text-gray-400">
          {datasets.length} exported
        </span>
      </div>
      <p className="max-w-2xl text-xs text-gray-500">
        Select a dataset to inspect it like a recording: metadata, topics, loss
        report, and camera previews read straight from the exported directory.
      </p>

      {datasetsQuery.isError ? (
        <ErrorMessage error={datasetsQuery.error} />
      ) : datasetsQuery.isPending ? (
        <p className="text-sm text-gray-500">Loading datasets…</p>
      ) : datasets.length === 0 ? (
        <p className="text-sm text-gray-500">No datasets yet.</p>
      ) : (
        <>
          {selected && collapsed && (
            <button
              type="button"
              onClick={() => setCollapsed(false)}
              aria-label="Expand dataset detail"
              className="flex items-center justify-between gap-2 rounded-card border border-gray-200 bg-white px-3 py-2 text-left shadow-card transition-colors hover:bg-gray-50"
            >
              <span className="truncate font-mono text-xs font-semibold text-teal-700">
                {selected.operator}/{selected.task}/{selected.index}
              </span>
              <span className="shrink-0 text-xs font-semibold text-gray-500">
                Expand ▸
              </span>
            </button>
          )}
          <div className={cn('grid grid-cols-1 gap-4', showDetail && 'md:grid-cols-2')}>
            <div className="flex flex-col gap-5">
              {groups.map((group) => (
                <div key={group.operator} className="flex flex-col gap-3">
                  <div className="font-mono text-sm font-semibold text-gray-700">
                    {group.operator}
                  </div>
                  {group.tasks.map(({ task, entries }) => (
                    <div key={task} className="flex flex-col gap-2 pl-3">
                      <div className="font-mono text-xs text-gray-500">{task}</div>
                      <div
                        className={cn(
                          'grid grid-cols-1 gap-[14px] sm:grid-cols-2',
                          !showDetail && 'lg:grid-cols-3',
                        )}
                      >
                        {entries.map((entry) => (
                          <DatasetCard
                            key={entry.dataset_dir}
                            entry={entry}
                            selected={selected?.dataset_dir === entry.dataset_dir}
                            onSelect={() => {
                              setSelected(entry);
                              setCollapsed(false);
                            }}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
            {showDetail && selected && (
              <Card aria-label="dataset detail" className="p-[18px]">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <h3 className="break-all font-mono text-sm font-semibold text-teal-700">
                    {selected.operator}/{selected.task}/{selected.index}
                  </h3>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setPendingDelete(selected)}
                      className="inline-flex items-center gap-1 rounded-control border border-red-200 px-2.5 py-1 text-xs font-semibold text-red-700 hover:bg-red-50"
                    >
                      <TrashIcon />
                      Delete
                    </button>
                    <button
                      type="button"
                      onClick={() => setCollapsed(true)}
                      aria-label="Minimize dataset detail"
                      className="rounded-control border border-gray-200 px-2.5 py-1 text-xs font-semibold text-gray-600 hover:bg-gray-50"
                    >
                      Minimize
                    </button>
                  </div>
                </div>
                <DatasetDetailView entry={selected} />
              </Card>
            )}
          </div>
        </>
      )}

      <Modal
        open={!!pendingDelete}
        onClose={() => setPendingDelete(null)}
        title="Delete dataset"
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
        <span className="font-mono text-gray-800">
          {pendingDelete
            ? `${pendingDelete.operator}/${pendingDelete.task}/${pendingDelete.index}`
            : ''}
        </span>
        ? The exported files are removed from disk. This cannot be undone.
        {deleteMutation.isError && (
          <div className="mt-2">
            <ErrorMessage error={deleteMutation.error} />
          </div>
        )}
      </Modal>
    </section>
  );
}

/** Invalidate the runs list + the datasets list after a successful export. */
function useInvalidateAfterExport() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.runs(undefined) });
    queryClient.invalidateQueries({ queryKey: queryKeys.datasets });
  };
}

function RunExportCard({ run, focus = false }: { run: RunSummary; focus?: boolean }) {
  const invalidate = useInvalidateAfterExport();
  // When deep-linked from a Recordings-tab "Export", scroll this card into view
  // and ring it so the operator lands on the right run instead of hunting.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focus) ref.current?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  }, [focus]);
  const mutation = useMutation({
    mutationFn: () =>
      apiPost<DatasetExportSummary>('/datasets/export', { run_id: run.run_id }),
    onSuccess: invalidate,
  });

  return (
    <div
      ref={ref}
      className={cn('rounded-card', focus && 'ring-2 ring-teal-400 ring-offset-2')}
    >
      <Card className="flex h-full flex-col gap-3 p-[18px]">
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
          <div className="text-gray-400">Operator</div>
          <div className="mt-0.5 font-mono text-gray-700">{run.operator || '—'}</div>
        </div>
        <div>
          <div className="text-gray-400">Task</div>
          <div className="mt-0.5 font-mono text-gray-700">{run.task || '—'}</div>
        </div>
        <div>
          <div className="text-gray-400">Recorded</div>
          <div className="mt-0.5 font-mono text-gray-700">{formatWhen(run.started_at)}</div>
        </div>
        <div>
          <div className="text-gray-400">State</div>
          <div className="mt-0.5 font-mono text-gray-700">{run.state}</div>
        </div>
      </div>
      <div className="flex-1" />
      <Button
        type="button"
        onClick={() => mutation.mutate()}
        disabled={mutation.isPending}
        className="px-3 py-1.5 text-xs"
      >
        {mutation.isPending ? 'Exporting…' : 'Export'}
      </Button>
        {mutation.isError && <ErrorMessage error={mutation.error} />}
      </Card>
    </div>
  );
}

function ExportSection({ focusRun }: { focusRun: string | null }) {
  const invalidate = useInvalidateAfterExport();
  const runsQuery = useQuery({
    queryKey: queryKeys.runs(undefined),
    queryFn: ({ signal }) =>
      apiGet<Page<RunSummary>>('/runs', { signal, query: { limit: 50 } }),
    placeholderData: keepPreviousData,
  });
  const runs = (runsQuery.data?.items ?? []).filter((r) => r.state === 'completed');

  const exportAll = useMutation({
    mutationFn: () => apiPost<ExportAllResponse>('/datasets/export-all', undefined),
    onSuccess: invalidate,
  });

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <SectionLabel>Export</SectionLabel>
        <span className="font-mono text-[11.5px] text-gray-400">
          {runs.length} completed
        </span>
      </div>
      <p className="max-w-2xl text-xs text-gray-500">
        Export moves a completed recording into{' '}
        <span className="font-mono">data/&lt;operator&gt;/&lt;task&gt;/NNN</span> (operator /
        task come from session.json; repeats are numbered 001, 002, …). The recording leaves
        the Recordings list once exported.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          onClick={() => exportAll.mutate()}
          disabled={exportAll.isPending || runs.length === 0}
          className="px-3 py-1.5 text-xs"
        >
          {exportAll.isPending ? 'Exporting all…' : 'Export all completed recordings'}
        </Button>
        {exportAll.isSuccess && (
          <span className="font-mono text-[11.5px] text-gray-500" data-testid="export-all-result">
            {exportAll.data.exported.length} exported, {exportAll.data.failed.length} failed
          </span>
        )}
      </div>
      {exportAll.isSuccess && exportAll.data.failed.length > 0 && (
        <ul className="flex flex-col gap-1" data-testid="export-all-failures">
          {exportAll.data.failed.map((f) => (
            <li
              key={f.run_id}
              className="rounded bg-red-50 px-3 py-1.5 text-xs text-red-700"
            >
              <span className="font-mono font-semibold">{f.run_id}</span>: {f.error}
            </li>
          ))}
        </ul>
      )}
      {exportAll.isError && <ErrorMessage error={exportAll.error} />}

      {runsQuery.isError ? (
        <ErrorMessage error={runsQuery.error} />
      ) : runsQuery.isPending ? (
        <p className="text-sm text-gray-500">Loading runs…</p>
      ) : runs.length === 0 ? (
        <p className="text-sm text-gray-500">
          No completed recordings yet. Record on the Live tab and they appear here.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-[18px] sm:grid-cols-2 lg:grid-cols-3">
          {runs.map((run) => (
            <RunExportCard key={run.run_id} run={run} focus={run.run_id === focusRun} />
          ))}
        </div>
      )}
    </section>
  );
}

export function DatasetTab() {
  // Consume a run parked by a Recordings-tab "Export" deep-link: highlight it in
  // the export grid once, then clear the marker so it doesn't re-fire.
  const pendingRun = useUiStore((s) => s.pendingRun);
  const setPendingRun = useUiStore((s) => s.setPendingRun);
  const [focusRun, setFocusRun] = useState<string | null>(null);
  useEffect(() => {
    if (pendingRun) {
      setFocusRun(pendingRun);
      setPendingRun(null);
    }
  }, [pendingRun, setPendingRun]);

  return (
    <div className="flex flex-col gap-8">
      <ExportSection focusRun={focusRun} />
      <DatasetsSection />
    </div>
  );
}
