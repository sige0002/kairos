// Dataset tab: export recordings into the tree, then browse exported datasets.
//
// Export (top): "Export all completed recordings" (POST /datasets/export-all)
// plus a per-completed-run "Export" button (POST /datasets/export).
// Datasets (below): GET /api/v1/datasets, grouped operator -> task -> [NNN].
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
import { apiGet, apiPost } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import { useUiStore } from '../../store/uiStore';
import type {
  DatasetEntry,
  DatasetExportSummary,
  DatasetsResponse,
  ExportAllResponse,
  Page,
  RunSummary,
} from '../../api/types';
import { ErrorMessage } from '../../components/ErrorMessage';
import { Badge, Button, Card, SectionLabel, cn } from '../../components/ui';

function formatWhen(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

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

function DatasetCard({ entry }: { entry: DatasetEntry }) {
  return (
    <Card className="flex flex-col gap-2 p-[14px]">
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
  );
}

function DatasetsSection() {
  const datasetsQuery = useQuery({
    queryKey: queryKeys.datasets,
    queryFn: ({ signal }) => apiGet<DatasetsResponse>('/datasets', { signal }),
    placeholderData: keepPreviousData,
  });

  const datasets = datasetsQuery.data?.datasets ?? [];
  const groups = groupDatasets(datasets);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <SectionLabel>Datasets</SectionLabel>
        <span className="font-mono text-[11.5px] text-gray-400">
          {datasets.length} exported
        </span>
      </div>

      {datasetsQuery.isError ? (
        <ErrorMessage error={datasetsQuery.error} />
      ) : datasetsQuery.isPending ? (
        <p className="text-sm text-gray-500">Loading datasets…</p>
      ) : datasets.length === 0 ? (
        <p className="text-sm text-gray-500">No datasets yet.</p>
      ) : (
        <div className="flex flex-col gap-5">
          {groups.map((group) => (
            <div key={group.operator} className="flex flex-col gap-3">
              <div className="font-mono text-sm font-semibold text-gray-700">
                {group.operator}
              </div>
              {group.tasks.map(({ task, entries }) => (
                <div key={task} className="flex flex-col gap-2 pl-3">
                  <div className="font-mono text-xs text-gray-500">{task}</div>
                  <div className="grid grid-cols-1 gap-[14px] sm:grid-cols-2 lg:grid-cols-3">
                    {entries.map((entry) => (
                      <DatasetCard key={entry.dataset_dir} entry={entry} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
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
