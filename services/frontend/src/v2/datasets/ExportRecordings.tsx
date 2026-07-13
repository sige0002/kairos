// The real "export recordings" working path (v1 parity, v2-styled). Completed
// recordings come from GET /runs (state === 'completed'); each row's Export
// (POST /datasets/export) and the "Export all" button (POST
// /datasets/export-all) MOVE the recording into data/<operator>/<task>/NNN.
//
// Console v2 pipeline UX: rows are now episode-context provenance rows (batch,
// episode #, task, operator, quality/task-result/review-status chips, recorded-
// at, duration, size), read from the Phase-2 `run.episode` join and rendered
// with the SAME chips as Review so both read as one pipeline step. Grouped by
// batch (adopted-containing batches first), non-adopted rows de-emphasized, with
// a Show-all / Adopted filter. Honesty: missing values render "—". This is the
// catch-up path (move any recording one at a time); Review is where you decide
// and bulk-export the adopted set — a "Decide in Review →" link crosslinks them.
//
// Export is a MOVE: on any success we invalidate BOTH the runs list (so the
// exported run leaves Recordings/Review) and the datasets list (so it appears
// here) — the same double invalidation v1 used.

import { useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type {
  DatasetExportSummary,
  ExportAllResponse,
  Page,
  RunEpisode,
  RunSummary,
} from '../../api/types';
import { ErrorMessage } from '../../components/ErrorMessage';
import { cn } from '../../components/ui';
import { useUiStore } from '../../store/uiStore';
import { BatchChip, QualityChip, ReviewStatusChip, TaskResultChip } from '../episodeChips';
import type { Quality, TaskResult } from '../review/types';
import { formatWhen } from './data';

const Q_MAP: Record<RunEpisode['quality'], Quality> = {
  good: 'Good',
  needs_review: 'Needs review',
  not_usable: 'Not usable',
};
const T_MAP: Record<RunEpisode['task_result'], TaskResult> = {
  success: 'Success',
  failure: 'Failure',
};

function formatHms(ms?: number): string {
  if (ms == null || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
function formatBytes(bytes?: number | null): string {
  if (bytes == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

/** Invalidate the runs list + the datasets list after a successful export.
 *  MOVE semantics: the run leaves Recordings/Review and appears in Datasets. */
function useInvalidateAfterExport() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.runs(undefined) });
    queryClient.invalidateQueries({ queryKey: queryKeys.datasets });
  };
}

function EpisodeExportRow({ run }: { run: RunSummary }) {
  const invalidate = useInvalidateAfterExport();
  const setActiveTab = useUiStore((s) => s.setActiveTab);
  const setPendingRun = useUiStore((s) => s.setPendingRun);
  const ep = run.episode ?? null;
  const bytes = (run as RunSummary & { bytes?: number | null }).bytes ?? null;
  const adopted = ep?.review_status === 'adopted';
  const mutation = useMutation({
    mutationFn: () => apiPost<DatasetExportSummary>('/datasets/export', { run_id: run.run_id }),
    onSuccess: invalidate,
  });

  return (
    <div
      data-testid={`export-run-${run.run_id}`}
      className={cn(
        'flex flex-col gap-1.5 rounded-[11px] border px-3 py-[9px]',
        adopted ? 'border-teal-200 bg-teal-50/40' : 'border-gray-100 opacity-70',
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <BatchChip batchSeq={ep?.batch_seq} isoDate={ep?.batch_created_at ?? run.started_at} />
        {ep && (
          <span className="font-mono text-[12px] font-semibold text-gray-800">
            #{ep.index_in_batch}
          </span>
        )}
        <span className="min-w-0 truncate text-[12px] text-gray-600" title={run.task ?? undefined}>
          {run.task || '—'}
        </span>
        <div className="flex-1" />
        {ep ? (
          <ReviewStatusChip status={ep.review_status} testId={`export-status-${run.run_id}`} />
        ) : (
          <span className="font-mono text-[11px] text-gray-300">no episode</span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <QualityChip quality={ep ? Q_MAP[ep.quality] : null} />
        <TaskResultChip task={ep ? T_MAP[ep.task_result] : null} />
        <div className="flex-1" />
        <span className="font-mono text-[11px] text-gray-400">{run.operator || '—'}</span>
      </div>
      <div className="flex items-center gap-2 text-[11px] text-gray-400">
        <span className="font-mono">{formatWhen(run.started_at)}</span>
        <span>·</span>
        <span className="font-mono">{formatHms(run.duration_ms)}</span>
        <span>·</span>
        <span className="font-mono">{formatBytes(bytes)}</span>
        <div className="flex-1" />
        <button
          type="button"
          data-testid={`export-decide-${run.run_id}`}
          onClick={() => {
            setPendingRun(run.run_id);
            setActiveTab('review');
          }}
          className="font-semibold text-teal-700 hover:underline"
        >
          Decide in Review →
        </button>
      </div>
      <button
        type="button"
        data-testid={`export-run-btn-${run.run_id}`}
        onClick={() => mutation.mutate()}
        disabled={mutation.isPending}
        className="mt-0.5 h-[30px] rounded-[9px] border border-teal-200 text-xs font-bold text-teal-700 hover:bg-teal-50 disabled:opacity-50"
      >
        {mutation.isPending ? 'Exporting…' : 'Export'}
      </button>
      {mutation.isError && <ErrorMessage error={mutation.error} />}
    </div>
  );
}

interface BatchGroup {
  key: string;
  header: string;
  hasAdopted: boolean;
  batchSeq: number | null;
  runs: RunSummary[];
}

/** Group completed runs by their episode's batch (adopted-containing batches
 *  first), each sorted by index_in_batch; runs without an episode go last. */
function groupByBatch(runs: RunSummary[]): BatchGroup[] {
  const map = new Map<string, BatchGroup>();
  for (const run of runs) {
    const ep = run.episode ?? null;
    const key = ep?.batch_id ?? '__none__';
    let g = map.get(key);
    if (!g) {
      const label =
        ep && ep.batch_seq != null
          ? `Batch #${ep.batch_seq}${run.task ? ` — ${run.task}` : ''}`
          : 'No batch (pre-Phase-2)';
      g = { key, header: label, hasAdopted: false, batchSeq: ep?.batch_seq ?? null, runs: [] };
      map.set(key, g);
    }
    if (ep?.review_status === 'adopted') g.hasAdopted = true;
    g.runs.push(run);
  }
  const groups = [...map.values()];
  for (const g of groups) {
    g.runs.sort((a, b) => (a.episode?.index_in_batch ?? 0) - (b.episode?.index_in_batch ?? 0));
  }
  // Adopted-containing batches first, then newest batch_seq first, "No batch" last.
  return groups.sort((a, b) => {
    if (a.hasAdopted !== b.hasAdopted) return a.hasAdopted ? -1 : 1;
    if (a.key === '__none__') return 1;
    if (b.key === '__none__') return -1;
    return (b.batchSeq ?? 0) - (a.batchSeq ?? 0);
  });
}

export function ExportRecordings() {
  const invalidate = useInvalidateAfterExport();
  const [filter, setFilter] = useState<'all' | 'adopted'>('all');
  const runsQuery = useQuery({
    queryKey: queryKeys.runs(undefined),
    queryFn: ({ signal }) => apiGet<Page<RunSummary>>('/runs', { signal, query: { limit: 50 } }),
    placeholderData: keepPreviousData,
  });
  const completed = useMemo(
    () => (runsQuery.data?.items ?? []).filter((r) => r.state === 'completed'),
    [runsQuery.data],
  );
  const nAdopted = completed.filter((r) => r.episode?.review_status === 'adopted').length;
  const shown =
    filter === 'adopted' ? completed.filter((r) => r.episode?.review_status === 'adopted') : completed;
  const groups = useMemo(() => groupByBatch(shown), [shown]);

  const exportAll = useMutation({
    mutationFn: () => apiPost<ExportAllResponse>('/datasets/export-all', undefined),
    onSuccess: invalidate,
  });

  return (
    <section data-testid="export-recordings" className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
          Export recordings
        </span>
        <span className="font-mono text-[11px] text-gray-400">{completed.length} completed</span>
        <div className="flex-1" />
        <div className="flex items-center gap-0.5 rounded-control border border-gray-200 p-0.5">
          {(['all', 'adopted'] as const).map((f) => (
            <button
              key={f}
              type="button"
              data-testid={`export-filter-${f}`}
              onClick={() => setFilter(f)}
              className={cn(
                'rounded-[7px] px-2.5 py-1 text-[11.5px] font-semibold transition-colors',
                filter === f ? 'bg-teal-600 text-white' : 'text-gray-500 hover:bg-gray-50',
              )}
            >
              {f === 'all' ? 'All' : `Adopted (${nAdopted})`}
            </button>
          ))}
        </div>
      </div>
      <p className="text-[11.5px] leading-relaxed text-gray-500">
        Export moves a completed recording into{' '}
        <span className="font-mono">data/&lt;operator&gt;/&lt;task&gt;/NNN</span>. Adopted?{' '}
        <span className="font-semibold text-teal-700">Review</span> bulk-exports the whole adopted
        set in one click — this list moves any recording one at a time.
      </p>

      <button
        type="button"
        data-testid="export-all-btn"
        onClick={() => exportAll.mutate()}
        disabled={exportAll.isPending || completed.length === 0}
        className="h-9 rounded-[10px] bg-teal-600 text-[13px] font-bold text-white hover:bg-teal-700 disabled:opacity-50"
      >
        {exportAll.isPending ? 'Exporting all…' : `Export all (${completed.length})`}
      </button>

      {exportAll.isSuccess && (
        <span data-testid="export-all-result" className="font-mono text-[11px] text-gray-500">
          {exportAll.data.exported.length} exported, {exportAll.data.failed.length} failed
        </span>
      )}
      {exportAll.isSuccess && exportAll.data.failed.length > 0 && (
        <ul data-testid="export-all-failures" className="flex flex-col gap-1">
          {exportAll.data.failed.map((f) => (
            <li key={f.run_id} className="rounded-[8px] bg-red-50 px-2.5 py-1.5 text-[11px] text-red-700">
              <span className="font-mono font-semibold">{f.run_id}</span>: {f.error}
            </li>
          ))}
        </ul>
      )}
      {exportAll.isError && <ErrorMessage error={exportAll.error} />}

      {runsQuery.isError ? (
        <ErrorMessage error={runsQuery.error} />
      ) : runsQuery.isPending ? (
        <span className="text-[12.5px] text-gray-400">Loading recordings…</span>
      ) : completed.length === 0 ? (
        <span data-testid="export-empty" className="text-[12.5px] leading-relaxed text-gray-400">
          No completed recordings to export yet. Record on the Collect tab and they appear here.
        </span>
      ) : (
        <div className="flex max-h-[320px] flex-col gap-2.5 overflow-auto pr-0.5">
          {groups.map((g) => (
            <div key={g.key} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2 px-0.5">
                <span
                  data-testid={`export-group-${g.key}`}
                  className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-gray-500"
                >
                  {g.header}
                </span>
                {g.hasAdopted && (
                  <span className="rounded-chip bg-teal-100 px-1.5 py-0.5 text-[9.5px] font-bold text-teal-700">
                    ADOPTED
                  </span>
                )}
              </div>
              {g.runs.map((run) => (
                <EpisodeExportRow key={run.run_id} run={run} />
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
