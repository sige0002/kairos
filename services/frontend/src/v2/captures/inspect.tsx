// Shared post-hoc inspection pieces for a capture's content: JSON sidecar
// blocks, the loss_report table, and the on-demand video_check mp4 players.
//
// Relocated out of the retired features/inspect tab (§12): the v2 screens are
// the only UI, and these are the reusable parts they need. Every job here is
// keyed by `capture_id` (§10.5) — there is no `dataset_dir` param any more,
// because a dataset no longer has a directory. A job resolves its source as
// `objects/<capture_id>` and writes to `report/<pipeline>/<capture_id>/`,
// which is the same path whether or not the capture belongs to a dataset.

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { apiGet, apiPost, getApiBase } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import { INSPECTION_JOB_POLL_MS } from '../pollingPolicy';
import type {
  CaptureTopic,
  JobResult,
  JobStatus,
  LossTopic,
  VideoCheckSummary,
} from '../../api/types';
import { JobErrorNote } from './JobErrorNote';
import { useJobSlot } from './jobQueue';

// Terminal job states; while a job is non-terminal we keep polling.
export const TERMINAL = new Set(['succeeded', 'failed', 'canceled']);

export function formatWhen(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('en-GB', { hour12: false });
}

export function formatDuration(ms?: number): string {
  if (ms === undefined || ms === null) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

/** Milliseconds between two ISO instants (undefined when indeterminate). */
export function spanMs(started?: string | null, ended?: string | null): number | undefined {
  if (!started || !ended) return undefined;
  const start = new Date(started).getTime();
  const end = new Date(ended).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return undefined;
  return end - start;
}

export function JsonBlock({ label, value }: { label: string; value: unknown }) {
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

export function fmtNum(value?: number | null, digits = 1): string {
  return value === undefined || value === null ? '—' : value.toFixed(digits);
}

// Loss tone: amber when any is lost, green when clean, gray when uncomputable.
function lossTone(loss?: number | null): { text: string; cls: string } {
  if (loss === undefined || loss === null) return { text: '—', cls: 'text-gray-400' };
  if (loss > 0) return { text: `${(loss * 100).toFixed(1)}%`, cls: 'text-amber-600' };
  return { text: '0%', cls: 'text-green-600' };
}

export function LossTable({ topics }: { topics: LossTopic[] }) {
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
                <td className="truncate px-2 py-1.5 font-mono text-gray-700" title={t.name}>
                  {t.name}
                </td>
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
export function cameraTopics(topics: CaptureTopic[]): CaptureTopic[] {
  return topics.filter((t) => /image/i.test(t.type) || /image/i.test(t.name));
}

// One self-contained camera preview: on mount it creates a video_check job for
// its topic, polls to terminal, fetches the result, and plays the served mp4.
// Event-driven only — it runs because the operator asked for this topic.
export function VideoPlayer({
  captureId,
  topic,
  onTimeUpdate,
  seekTo,
  onSummary,
}: {
  captureId: string;
  topic: string;
  /** Synced playback (Review Signals): report the video clock on every frame. */
  onTimeUpdate?: (currentTime: number, duration: number) => void;
  /** Seek request from the chart — a NEW object per seek (memoized by the
   *  parent so a re-render doesn't re-apply a stale seek and fight playback). */
  seekTo?: { seconds: number; nonce: number } | null;
  /** The loaded video_check summary (so the parent learns duration/truncated). */
  onSummary?: (summary: VideoCheckSummary) => void;
}) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [summary, setSummary] = useState<VideoCheckSummary | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const started = useRef(false);
  // Set when the operator asked for a full re-encode, so the queued submission
  // carries the knobs the click meant rather than the mount defaults.
  const reencodeRef = useRef(false);
  // Sync plumbing: the <video> element + latest callbacks (refs keep the query
  // callbacks and event handlers out of effect deps).
  const videoRef = useRef<HTMLVideoElement>(null);
  const onTimeUpdateRef = useRef(onTimeUpdate);
  onTimeUpdateRef.current = onTimeUpdate;
  const onSummaryRef = useRef(onSummary);
  onSummaryRef.current = onSummary;

  // This player wants to run a job until it has an answer. The slot is what
  // keeps five camera tiles from submitting at once and losing four of them to
  // the per-capture lease (§7.1) — see jobQueue.ts.
  const wantSlot = summary === null && jobError === null;
  const slot = useJobSlot(captureId, wantSlot);

  const mutation = useMutation({
    // `extra` carries the re-encode knobs (force + max_frames); the initial
    // mount job sends none and gets the cached/short preview semantics.
    mutationFn: (extra: { force?: boolean; max_frames?: number } | void) =>
      apiPost<JobStatus>('/jobs', {
        pipeline: 'video_check',
        capture_id: captureId,
        params: { topic, ...(extra ?? {}) },
      }),
    onSuccess: (job) => setJobId(job.job_id),
    // A submission that never became a job holds nothing, so the next preview
    // must not wait on it.
    onError: () => slot.release(),
  });

  // Re-encode the WHOLE episode (force bypasses the cache; 0 = no frame cap).
  // The old mp4 keeps playing elsewhere until the new encode atomically lands.
  // It joins the same queue: a manual click during a burst of auto-submits is
  // the same contention as any other.
  const reencodeFull = () => {
    setSummary(null);
    setJobError(null);
    reencodeRef.current = true;
    started.current = false;
  };

  // Submit once this player holds the capture (StrictMode-safe). Waiting is not
  // an error state — the tile says where it is in the queue instead.
  useEffect(() => {
    if (!slot.granted || started.current) return;
    started.current = true;
    const extra = reencodeRef.current ? { force: true, max_frames: 0 } : undefined;
    reencodeRef.current = false;
    mutation.mutate(extra);
  }, [slot.granted, mutation]);

  // Apply a seek from the chart. `seekTo` is a fresh object per seek, so the
  // effect fires exactly on a real seek (not on every parent re-render).
  useEffect(() => {
    const v = videoRef.current;
    if (v && seekTo) v.currentTime = seekTo.seconds;
  }, [seekTo]);

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
          const s = result.summary as VideoCheckSummary;
          setSummary(s);
          onSummaryRef.current?.(s);
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
        // Terminal either way: hand the capture to the next preview. A failed
        // job must release exactly like a successful one, or one broken topic
        // strands every tile queued behind it.
        slot.release();
      }
      return status;
    },
    enabled: !!jobId,
    refetchInterval: (q) => {
      const state = q.state.data?.state;
      return state && TERMINAL.has(state) ? false : INSPECTION_JOB_POLL_MS;
    },
  });

  return (
    <div className="flex flex-col gap-1">
      <div className="truncate font-mono text-[11px] text-gray-600" title={topic}>
        {topic}
      </div>
      {mutation.isError ? (
        <JobErrorNote error={mutation.error} testId="video-submit-error" />
      ) : jobError ? (
        <p role="alert" className="text-xs text-red-600">
          {jobError}
        </p>
      ) : !slot.granted && wantSlot ? (
        // Waiting for its turn is not a failure, and must not read as one:
        // only one job may hold a capture at a time (§7.1), so the tiles take
        // turns rather than four of them being refused.
        <p className="text-xs text-gray-500" data-testid="video-queued">
          Queued behind {slot.ahead} other preview{slot.ahead === 1 ? '' : 's'}…
        </p>
      ) : summary && summary.file ? (
        <>
          <video
            ref={videoRef}
            controls
            src={`${getApiBase()}/files/${summary.file}`}
            onTimeUpdate={(e) =>
              onTimeUpdateRef.current?.(
                e.currentTarget.currentTime,
                e.currentTarget.duration,
              )
            }
            onLoadedMetadata={(e) =>
              onTimeUpdateRef.current?.(
                e.currentTarget.currentTime,
                e.currentTarget.duration,
              )
            }
            className="w-full rounded-control border border-gray-200 bg-black"
          />
          <p className="text-[10px] text-gray-400">
            {summary.frames} frames · {fmtNum(summary.fps, 0)}fps
            {summary.truncated
              ? ` · head only (${summary.total_messages ?? '?'} msgs in the episode)`
              : ''}
            {summary.cached ? ' · cached' : ''}
            {summary.truncated && (
              <button
                type="button"
                onClick={reencodeFull}
                className="ml-1.5 font-semibold text-teal-700 hover:underline"
              >
                Re-encode full episode
              </button>
            )}
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
export function VideoCheckSection({
  topics,
  captureId,
  blockedReason,
}: {
  topics: CaptureTopic[];
  captureId: string;
  /** Why generation is unavailable right now (a held lease, §7.1). The
   *  operator learns it from the control rather than from a 409. */
  blockedReason?: string | null;
}) {
  const cameras = cameraTopics(topics);
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
            disabled={!topic || !!blockedReason}
            title={blockedReason ?? undefined}
            className="rounded-control border border-teal-200 px-2.5 py-1 text-xs font-semibold text-teal-700 hover:bg-teal-50 disabled:opacity-50"
          >
            Generate mp4
          </button>
          <button
            type="button"
            onClick={() => setPlayers(cameras.map((c) => c.name))}
            disabled={cameras.length === 0 || !!blockedReason}
            title={blockedReason ?? undefined}
            className="rounded-control border border-gray-200 px-2.5 py-1 text-xs font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-50"
          >
            All cameras
          </button>
        </div>
      </div>
      {blockedReason && (
        <p className="text-[11.5px] text-amber-700" data-testid="video-blocked">
          {blockedReason}
        </p>
      )}
      {players.length === 0 ? (
        <p className="text-xs text-gray-500">
          Preview the leading frames of a camera topic as an mp4 — one camera, or all at once.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {players.map((t) => (
            <VideoPlayer key={t} captureId={captureId} topic={t} />
          ))}
        </div>
      )}
    </section>
  );
}
