// The real "export recordings" working path (v1 parity, v2-styled). Completed
// recordings come from GET /runs (state === 'completed'); each row's Export
// (POST /datasets/export) and the "Export all" button (POST
// /datasets/export-all) MOVE the recording into data/<operator>/<task>/NNN.
//
// Export is a MOVE: on any success we invalidate BOTH the runs list (so the
// exported run leaves Recordings/Review) and the datasets list (so it appears
// in this screen's catalog) — the same double invalidation v1 used
// (src/features/dataset/DatasetTab.tsx: queryKeys.runs(undefined) +
// queryKeys.datasets). This is the working path; the Recipe/Build cards remain
// Phase 2 mocks.

import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { apiGet, apiPost } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type {
  DatasetExportSummary,
  ExportAllResponse,
  Page,
  RunSummary,
} from '../../api/types';
import { ErrorMessage } from '../../components/ErrorMessage';
import { formatWhen } from './data';

/** Invalidate the runs list + the datasets list after a successful export.
 * MOVE semantics: the run leaves Recordings/Review and appears in Datasets.
 * Exact keys copied from v1 (src/features/dataset/DatasetTab.tsx). */
function useInvalidateAfterExport() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.runs(undefined) });
    queryClient.invalidateQueries({ queryKey: queryKeys.datasets });
  };
}

function RunExportRow({ run }: { run: RunSummary }) {
  const invalidate = useInvalidateAfterExport();
  const mutation = useMutation({
    mutationFn: () =>
      apiPost<DatasetExportSummary>('/datasets/export', { run_id: run.run_id }),
    onSuccess: invalidate,
  });

  return (
    <div
      data-testid={`export-run-${run.run_id}`}
      className="flex flex-col gap-1.5 rounded-[11px] border border-gray-100 px-3 py-[9px]"
    >
      <span className="truncate font-mono text-[12px] font-semibold text-gray-900" title={run.run_id}>
        {run.run_id}
      </span>
      <div className="flex items-center gap-2 text-[11px] text-gray-500">
        <span className="min-w-0 truncate font-mono">
          {run.operator || '—'} / {run.task || '—'}
        </span>
        <div className="flex-1" />
        <span className="shrink-0 font-mono text-gray-400">{formatWhen(run.started_at)}</span>
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

export function ExportRecordings() {
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
    <section data-testid="export-recordings" className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
          Export recordings
        </span>
        <span className="font-mono text-[11px] text-gray-400">{runs.length} completed</span>
      </div>
      <p className="text-[11.5px] leading-relaxed text-gray-500">
        Export moves a completed recording into{' '}
        <span className="font-mono">data/&lt;operator&gt;/&lt;task&gt;/NNN</span> — it leaves
        Recordings once exported and appears in the catalog on the left.
      </p>

      <button
        type="button"
        data-testid="export-all-btn"
        onClick={() => exportAll.mutate()}
        disabled={exportAll.isPending || runs.length === 0}
        className="h-9 rounded-[10px] bg-teal-600 text-[13px] font-bold text-white hover:bg-teal-700 disabled:opacity-50"
      >
        {exportAll.isPending ? 'Exporting all…' : `Export all (${runs.length})`}
      </button>

      {exportAll.isSuccess && (
        <span data-testid="export-all-result" className="font-mono text-[11px] text-gray-500">
          {exportAll.data.exported.length} exported, {exportAll.data.failed.length} failed
        </span>
      )}
      {exportAll.isSuccess && exportAll.data.failed.length > 0 && (
        <ul data-testid="export-all-failures" className="flex flex-col gap-1">
          {exportAll.data.failed.map((f) => (
            <li
              key={f.run_id}
              className="rounded-[8px] bg-red-50 px-2.5 py-1.5 text-[11px] text-red-700"
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
        <span className="text-[12.5px] text-gray-400">Loading recordings…</span>
      ) : runs.length === 0 ? (
        <span data-testid="export-empty" className="text-[12.5px] leading-relaxed text-gray-400">
          No completed recordings to export yet. Record on the Collect tab and they appear here.
        </span>
      ) : (
        <div className="flex max-h-[280px] flex-col gap-2 overflow-auto pr-0.5">
          {runs.map((run) => (
            <RunExportRow key={run.run_id} run={run} />
          ))}
        </div>
      )}
    </section>
  );
}
