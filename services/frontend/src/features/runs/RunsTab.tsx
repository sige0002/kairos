// Runs tab: cursor-paginated list (GET /api/v1/runs) on the left, detail view
// (GET /api/v1/runs/{id}) on the right with manifest JSON and validation /
// dataset stats when present.

import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type { Page, RunDetail, RunSummary } from '../../api/types';
import { ErrorMessage } from '../../components/ErrorMessage';

function formatWhen(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function formatDuration(ms?: number): string {
  if (ms === undefined || ms === null) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  if (value === undefined || value === null) return null;
  return (
    <details className="rounded border p-2">
      <summary className="cursor-pointer font-medium">{label}</summary>
      <pre className="mt-2 max-h-80 overflow-auto rounded bg-gray-50 p-2 text-xs">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}

function RunDetailView({ runId }: { runId: string }) {
  const detailQuery = useQuery({
    queryKey: queryKeys.run(runId),
    queryFn: ({ signal }) =>
      apiGet<RunDetail>(`/runs/${encodeURIComponent(runId)}`, { signal }),
  });

  if (detailQuery.isPending)
    return <p className="text-sm text-gray-500">Loading run…</p>;
  if (detailQuery.isError) return <ErrorMessage error={detailQuery.error} />;
  const run = detailQuery.data;

  return (
    <div className="flex flex-col gap-3">
      <h3 className="font-mono text-sm font-semibold">{run.run_id}</h3>
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
        <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">
          {run.error.code}: {run.error.message}
        </p>
      )}

      <section>
        <h4 className="mb-1 text-sm font-medium">Topics ({run.topics.length})</h4>
        <ul className="max-h-48 overflow-auto rounded border text-xs">
          {run.topics.map((t) => (
            <li key={t.name} className="border-t px-2 py-1 first:border-t-0">
              <span className="font-mono">{t.name}</span>{' '}
              <span className="text-gray-500">{t.type}</span>
            </li>
          ))}
        </ul>
      </section>

      <JsonBlock label="Manifest" value={run.manifest} />
      <JsonBlock label="Validation" value={run.validation} />
      <JsonBlock label="Dataset stats" value={run.dataset_stats} />
    </div>
  );
}

export function RunsTab() {
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [selected, setSelected] = useState<string | null>(null);

  const runsQuery = useQuery({
    queryKey: queryKeys.runs(cursor),
    queryFn: ({ signal }) =>
      apiGet<Page<RunSummary>>('/runs', { signal, query: { cursor, limit: 50 } }),
    placeholderData: keepPreviousData,
  });

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <section aria-label="runs list" className="flex flex-col gap-2">
        <div>
          <h2 className="font-semibold">Runs</h2>
          <p className="text-xs text-gray-500">
            History of recordings. Each record start/stop is one run (MCAP under
            <span className="font-mono"> /data/recorded/&lt;run_id&gt;</span>); pick one to
            inspect its topics, manifest, and validation / dataset results.
          </p>
        </div>
        {runsQuery.isError ? (
          <ErrorMessage error={runsQuery.error} />
        ) : runsQuery.isPending ? (
          <p className="text-sm text-gray-500">Loading runs…</p>
        ) : runsQuery.data.items.length === 0 ? (
          <p className="text-sm text-gray-500">No runs yet.</p>
        ) : (
          <ul className="rounded border" role="list">
            {runsQuery.data.items.map((run) => (
              <li key={run.run_id} className="border-t first:border-t-0">
                <button
                  type="button"
                  onClick={() => setSelected(run.run_id)}
                  aria-pressed={selected === run.run_id}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50 ${
                    selected === run.run_id ? 'bg-blue-50' : ''
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-mono">{run.run_id}</span>
                    <span className="text-xs text-gray-500">
                      {formatWhen(run.started_at)}
                      {run.duration_ms ? ` · ${formatDuration(run.duration_ms)}` : ''}
                    </span>
                  </span>
                  <span className="shrink-0 text-gray-500">{run.state}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {runsQuery.data?.next_cursor && (
          <button
            type="button"
            onClick={() => setCursor(runsQuery.data.next_cursor ?? undefined)}
            className="self-start rounded border px-3 py-1 text-sm"
          >
            Load more
          </button>
        )}
      </section>

      <section aria-label="run detail" className="rounded border p-3">
        {selected ? (
          <RunDetailView runId={selected} />
        ) : (
          <p className="text-sm text-gray-500">Select a run to see details.</p>
        )}
      </section>
    </div>
  );
}
