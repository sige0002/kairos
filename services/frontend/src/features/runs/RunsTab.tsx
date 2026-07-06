// Runs tab: cursor-paginated list (GET /api/v1/runs) on the left, detail view
// (GET /api/v1/runs/{id}) on the right with manifest JSON and validation /
// dataset stats when present.

import { useEffect, useRef, useState } from 'react';
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { apiDelete, apiGet, apiPost, getApiBase } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type {
  JobResult,
  JobStatus,
  LossTopic,
  Page,
  RunDetail,
  RunSummary,
  RunTopic,
  VideoCheckSummary,
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
  type Tone,
} from '../../components/ui';
import { useUiStore } from '../../store/uiStore';

// Terminal job states; while a loss_report job is non-terminal we keep polling.
const TERMINAL = new Set(['succeeded', 'failed', 'canceled']);

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

/** A run's duration in ms: the backend `duration_ms` when present, otherwise
 *  derived from started_at/ended_at — the run-list payload omits duration_ms, so
 *  without this the list would never show a duration. */
function runDurationMs(run: {
  duration_ms?: number;
  started_at?: string;
  ended_at?: string | null;
}): number | undefined {
  if (run.duration_ms != null) return run.duration_ms;
  if (!run.started_at || !run.ended_at) return undefined;
  const start = new Date(run.started_at).getTime();
  const end = new Date(run.ended_at).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return undefined;
  return end - start;
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

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  if (value === undefined || value === null) return null;
  return (
    <details className="rounded-control border border-gray-200 p-2">
      <summary className="cursor-pointer text-sm font-medium text-gray-700">{label}</summary>
      <pre className="mt-2 max-h-80 overflow-auto rounded-control bg-gray-50 p-2 font-mono text-xs">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}

function fmtNum(value?: number | null, digits = 1): string {
  return value === undefined || value === null ? '—' : value.toFixed(digits);
}

// Loss tone: amber when any is lost, green when clean, gray when uncomputable.
function lossTone(loss?: number | null): { text: string; cls: string } {
  if (loss === undefined || loss === null) return { text: '—', cls: 'text-gray-400' };
  if (loss > 0) return { text: `${(loss * 100).toFixed(1)}%`, cls: 'text-amber-600' };
  return { text: '0%', cls: 'text-green-600' };
}

function LossTable({ topics }: { topics: LossTopic[] }) {
  if (topics.length === 0)
    return <p className="text-xs text-gray-500">No topics to analyze.</p>;
  return (
    <div className="overflow-auto rounded-control border border-gray-200">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-gray-100 text-[10px] uppercase tracking-[0.05em] text-gray-400">
            <th className="px-2 py-1.5 text-left font-medium">Topic</th>
            <th className="px-2 py-1.5 text-right font-medium">Hz</th>
            <th className="px-2 py-1.5 text-right font-medium">Loss</th>
            <th className="px-2 py-1.5 text-right font-medium">Max gap (ms)</th>
          </tr>
        </thead>
        <tbody>
          {topics.map((t) => {
            const tone = lossTone(t.loss_rate);
            return (
              <tr key={t.name} className="border-t border-gray-50">
                <td className="truncate px-2 py-1.5 font-mono text-gray-700">{t.name}</td>
                <td className="px-2 py-1.5 text-right font-mono text-gray-500">
                  {fmtNum(t.hz)}
                </td>
                <td className={`px-2 py-1.5 text-right font-mono font-semibold ${tone.cls}`}>
                  {tone.text}
                </td>
                <td className="px-2 py-1.5 text-right font-mono text-gray-500">
                  {fmtNum(t.gap_max_ms, 0)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Camera-ish topics: an image message type, or an /image/ topic name. These are
// the only topics video_check can render (it decodes CompressedImage JPEG).
function cameraTopics(topics: RunTopic[]): RunTopic[] {
  return topics.filter((t) => /image/i.test(t.type) || /image/i.test(t.name));
}

// One self-contained camera preview: on mount it creates a video_check job for
// its topic, polls to terminal, fetches the result, and plays the served mp4.
// Event-driven only — it runs because the operator asked for this topic.
function VideoPlayer({ runId, topic }: { runId: string; topic: string }) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [summary, setSummary] = useState<VideoCheckSummary | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const started = useRef(false);

  const mutation = useMutation({
    mutationFn: () =>
      apiPost<JobStatus>('/jobs', {
        pipeline: 'video_check',
        run_id: runId,
        params: { topic },
      }),
    onSuccess: (job) => setJobId(job.job_id),
  });

  // Kick the job off once (StrictMode-safe) when this player appears.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    mutation.mutate();
  }, [mutation]);

  useQuery({
    queryKey: queryKeys.job(jobId ?? ''),
    queryFn: async ({ signal }) => {
      const status = await apiGet<JobStatus>(
        `/jobs/${encodeURIComponent(jobId ?? '')}/status`,
        { signal },
      );
      if (jobId && TERMINAL.has(status.state)) {
        if (status.state === 'succeeded') {
          const result = await apiGet<JobResult>(
            `/jobs/${encodeURIComponent(jobId)}/result`,
            { signal },
          );
          setSummary(result.summary as VideoCheckSummary);
        } else {
          // failed/canceled: fetch the terminal result so the failure is shown
          // instead of spinning on "Generating…" forever. dora_runner nests the
          // ApiError under summary.error(.error).
          let message = `Video check ${status.state}.`;
          try {
            const result = await apiGet<JobResult>(
              `/jobs/${encodeURIComponent(jobId)}/result`,
              { signal },
            );
            const err = (result.summary as Record<string, unknown>)?.error as
              | { code?: string; message?: string; error?: { code?: string; message?: string } }
              | undefined;
            const code = err?.error?.code ?? err?.code;
            const msg = err?.error?.message ?? err?.message;
            if (msg) message = code ? `${msg} (${code})` : msg;
          } catch {
            // keep the generic message
          }
          setJobError(message);
        }
        setJobId(null);
      }
      return status;
    },
    enabled: !!jobId,
    refetchInterval: (q) => {
      const state = q.state.data?.state;
      return state && TERMINAL.has(state) ? false : 1500;
    },
  });

  return (
    <div className="flex flex-col gap-1">
      <div className="truncate font-mono text-[11px] text-gray-600" title={topic}>
        {topic}
      </div>
      {mutation.isError ? (
        <ErrorMessage error={mutation.error} />
      ) : jobError ? (
        <p role="alert" className="text-xs text-red-600">
          {jobError}
        </p>
      ) : summary && summary.file ? (
        <>
          <video
            controls
            src={`${getApiBase()}/files/${summary.file}`}
            className="w-full rounded-control border border-gray-200 bg-black"
          />
          <p className="text-[10px] text-gray-400">
            {summary.frames} frames · {fmtNum(summary.fps, 0)}fps
            {summary.truncated ? ' · head only' : ''}
            {summary.cached ? ' · cached' : ''}
          </p>
        </>
      ) : summary ? (
        <p className="text-xs text-gray-500">
          {summary.note ?? 'Could not generate video from this topic.'}
        </p>
      ) : (
        <p className="text-xs text-gray-500">Generating…</p>
      )}
    </div>
  );
}

// On-demand mp4 preview of camera topics. Two ways, both event-driven (a button
// creates the video_check job(s); nothing auto-converts): generate the SELECTED
// camera, or ALL cameras at once (one player each).
function VideoCheckSection({ run, runId }: { run: RunDetail; runId: string }) {
  const cameras = cameraTopics(run.topics);
  const [topic, setTopic] = useState<string>(cameras[0]?.name ?? '');
  // Camera topics we currently show players for (each player runs its own job).
  const [players, setPlayers] = useState<string[]>([]);

  if (cameras.length === 0)
    return (
      <section>
        <h4 className="mb-1.5 text-sm font-medium text-gray-700">Video check</h4>
        <p className="text-xs text-gray-500">No camera topics.</p>
      </section>
    );

  return (
    <section>
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-medium text-gray-700">Video check</h4>
        <div className="flex items-center gap-2">
          <select
            aria-label="camera topic"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            className="max-w-[180px] truncate rounded-control border border-gray-200 px-2 py-1 font-mono text-xs text-gray-700"
          >
            {cameras.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => topic && setPlayers([topic])}
            disabled={!topic}
            className="rounded-control border border-teal-200 px-2.5 py-1 text-xs font-semibold text-teal-700 hover:bg-teal-50 disabled:opacity-50"
          >
            Generate mp4
          </button>
          <button
            type="button"
            onClick={() => setPlayers(cameras.map((c) => c.name))}
            disabled={cameras.length === 0}
            className="rounded-control border border-gray-200 px-2.5 py-1 text-xs font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-50"
          >
            All cameras
          </button>
        </div>
      </div>
      {players.length === 0 ? (
        <p className="text-xs text-gray-500">
          Preview the leading frames of a camera topic as an mp4 — one camera, or all at once.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {players.map((t) => (
            <VideoPlayer key={t} runId={runId} topic={t} />
          ))}
        </div>
      )}
    </section>
  );
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

      {run.state === 'completed' && <VideoCheckSection run={run} runId={runId} />}

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
