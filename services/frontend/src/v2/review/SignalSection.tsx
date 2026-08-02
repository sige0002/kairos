// "Data integrity" section of the Review detail (RunInspection). Runs the dora
// `signal_report` pipeline (per-topic message timing over episode time) and
// answers the reviewer's actual question — is this episode's data whole? — with
// a synced video + an aggregated loss timeline under it + a per-event table +
// a per-topic summary. The raw numeric waveform chart this section used to draw
// was removed deliberately (a joint-angle plot doesn't answer "is this episode
// usable"); live waveform debugging stays in the Probe tab.
//
// Honest degradation (HCD): nothing auto-runs (an explicit button); a running
// job shows progress; a failed/absent pipeline says so plainly; a recording
// with no numeric topics says so and lists what was skipped; continuity is
// shown WITH its formula (tooltip) and as "n/a" when null. Timeline/event-row
// seeking only engages on a FULL-LENGTH video — a head-only preview would map
// the whole episode onto its first frames, which would lie.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type {
  JobResult,
  JobStatus,
  CaptureTopic,
  VideoCheckSummary,
} from '../../api/types';
import { JobErrorNote, isTombstoneError } from '../captures/JobErrorNote';
import { TERMINAL, VideoPlayer, cameraTopics } from '../captures/inspect';
import {
  episodeSpanNs,
  formatContinuity,
  globalNsToVideoSeconds,
  type SignalReportExt,
} from './signalReport';
import { LossTimeline } from './LossTimeline';
import { LossEventList } from './LossEventList';

// Run the signal_report pipeline (one shot) and return its parsed summary. Same
// POST /jobs → poll status → fetch result lifecycle the VideoPlayer uses, so a
// missing/failed pipeline surfaces as an honest error instead of a dead view.
function useSignalReport(captureId: string) {
  const queryClient = useQueryClient();
  const [jobId, setJobId] = useState<string | null>(null);
  const [report, setReport] = useState<SignalReportExt | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      apiPost<JobStatus>('/jobs', {
        pipeline: 'signal_report',
        capture_id: captureId,
        params: { topics: null, max_points: 2000 },
      }),
    onSuccess: (job) => {
      setReport(null);
      setJobError(null);
      setJobId(job.job_id);
    },
    onError: (error) => {
      // Same reasoning as the loss/validation jobs: a tombstone 409 is how this
      // panel finds out the capture was removed elsewhere.
      if (isTombstoneError(error)) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.capture(captureId) });
      }
    },
  });

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
          setReport(result.summary as unknown as SignalReportExt);
        } else {
          // failed/canceled: surface the terminal error (dora_runner nests the
          // ApiError under summary.error(.error)) instead of spinning forever.
          let message = `Integrity report ${status.state}.`;
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

  return {
    run: () => mutation.mutate(),
    running: mutation.isPending || !!jobId,
    report,
    error: mutation.isError ? mutation.error : null,
    jobError,
  };
}

export function SignalSection({
  captureId,
  topics,
}: {
  captureId: string;
  topics: CaptureTopic[];
}) {
  const sig = useSignalReport(captureId);
  const report = sig.report;

  const [syncCamera, setSyncCamera] = useState<string | null>(null);
  const cameras = cameraTopics(topics);
  const [cameraChoice, setCameraChoice] = useState<string>(cameras[0]?.name ?? '');

  // Video sync state, shared with the embedded VideoPlayer. The video clock is
  // the ONLY playhead source (there is no chart of its own anymore): its
  // currentTime/duration fraction positions the timeline playhead, and a
  // timeline/event click seeks the video through `seekTo`.
  const [videoDur, setVideoDur] = useState(0);
  const [videoTruncated, setVideoTruncated] = useState(false);
  const [videoFrac, setVideoFrac] = useState<number | null>(null);
  const [seekTo, setSeekTo] = useState<{ seconds: number; nonce: number } | null>(null);

  const numericTopics = report ? Object.keys(report.topics) : [];
  const spanNs = report ? episodeSpanNs(report) : 0;

  // Sync is honest only for a full-length video (covers the whole episode).
  const syncEnabled = !!syncCamera && !videoTruncated && videoDur > 0 && spanNs > 0;

  const onVideoTime = (currentTime: number, duration: number) => {
    if (Number.isFinite(duration) && duration > 0) {
      setVideoDur(duration);
      setVideoFrac(Math.min(1, Math.max(0, currentTime / duration)));
    }
  };
  const onVideoSummary = (s: VideoCheckSummary) => {
    setVideoTruncated(!!s.truncated);
    if (s.duration_s != null) setVideoDur(s.duration_s);
  };

  // Seek from the timeline / event list, which speak the episode-GLOBAL axis:
  // move the playhead immediately (feedback) and seek the synced video.
  const onSeekGlobal = (globalNs: number) => {
    if (!syncEnabled) return;
    setVideoFrac(Math.min(1, Math.max(0, spanNs > 0 ? globalNs / spanNs : 0)));
    setSeekTo({
      seconds: globalNsToVideoSeconds(globalNs, spanNs, videoDur),
      nonce: Date.now(),
    });
  };

  return (
    <section data-testid="review-signals">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-[12.5px] font-medium text-gray-700">Data integrity</h4>
        <button
          type="button"
          data-testid="review-run-signal"
          onClick={sig.run}
          disabled={sig.running}
          className="rounded-control border border-teal-200 px-2.5 py-1 text-[11.5px] font-semibold text-teal-700 transition-colors hover:bg-teal-50 disabled:opacity-50"
        >
          {sig.running
            ? 'Analysing…'
            : report
              ? 'Re-run integrity report'
              : 'Run integrity report'}
        </button>
      </div>

      <JobErrorNote error={sig.error} testId="review-signal-submit-error" />
      {sig.jobError && (
        <p role="alert" className="text-[11.5px] text-red-600" data-testid="review-signal-error">
          {sig.jobError}
        </p>
      )}

      {!report && !sig.running && !sig.jobError && !sig.error && (
        <p className="text-[11.5px] text-gray-500">
          Analyses each topic's message timing in the recording (signal_report) to
          locate gaps, shortfalls and silence — decoding stays isolated in the
          pipeline.
        </p>
      )}
      {sig.running && (
        <p className="text-[11.5px] text-gray-500" data-testid="review-signal-progress">
          Analysing message timing across the recording…
        </p>
      )}

      {report && numericTopics.length === 0 && (
        <p className="text-[11.5px] text-gray-500" data-testid="review-signal-empty">
          No numeric topics in this recording.
        </p>
      )}

      {report && numericTopics.length > 0 && (
        <div className="flex flex-col gap-2">
          {/* Synced video first (the reviewer's ground truth), the aggregated
              loss timeline directly under its scrubber, then per-event detail. */}
          {cameras.length > 0 && (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-gray-400">
                  Synced video
                </span>
                <select
                  aria-label="sync camera topic"
                  data-testid="review-signal-camera"
                  value={cameraChoice}
                  onChange={(e) => setCameraChoice(e.target.value)}
                  className="max-w-[180px] truncate rounded-control border border-gray-200 px-2 py-1 font-mono text-[11px] text-gray-700"
                >
                  {cameras.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  data-testid="review-signal-sync"
                  onClick={() => cameraChoice && setSyncCamera(cameraChoice)}
                  disabled={!cameraChoice}
                  className="rounded-control border border-teal-200 px-2.5 py-1 text-[11px] font-semibold text-teal-700 hover:bg-teal-50 disabled:opacity-50"
                >
                  {syncCamera === cameraChoice ? 'Loaded' : 'Load synced video'}
                </button>
              </div>
              {syncCamera && (
                <>
                  {videoTruncated && (
                    <p className="text-[11px] text-amber-700">
                      Head-only preview — use “Re-encode full episode” below to enable
                      seeking from the timeline across the whole episode.
                    </p>
                  )}
                  <VideoPlayer
                    key={syncCamera}
                    captureId={captureId}
                    topic={syncCamera}
                    onTimeUpdate={onVideoTime}
                    onSummary={onVideoSummary}
                    seekTo={seekTo}
                  />
                </>
              )}
            </div>
          )}

          <LossTimeline
            report={report}
            playheadFrac={syncEnabled ? videoFrac : null}
            seekEnabled={syncEnabled}
            onSeekGlobal={onSeekGlobal}
          />
          <LossEventList report={report} onSeekGlobal={onSeekGlobal} />

          {/* Per-topic numeric summary — the compact judgement row that replaced
              the waveform: how continuous each topic's data is, and how many
              loss events (majors highlighted) the pipeline located. */}
          <table
            className="w-full border-collapse text-[11px]"
            data-testid="review-topic-summary"
          >
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-[0.03em] text-gray-400">
                <th className="py-0.5 pr-2 font-medium">Topic</th>
                <th className="py-0.5 pr-2 font-medium">Messages</th>
                <th className="py-0.5 pr-2 font-medium">Continuity</th>
                <th className="py-0.5 font-medium">Loss events</th>
              </tr>
            </thead>
            <tbody>
              {numericTopics.map((name) => {
                const tr = report.topics[name]!;
                const events = tr.loss_events ?? [];
                const majors = events.filter((e) => e.severity === 'major').length;
                return (
                  <tr key={name} className="border-t border-gray-100">
                    <td
                      className="py-0.5 pr-2 font-mono text-gray-600"
                      title={tr.time_source ? `clock: ${tr.time_source}` : undefined}
                    >
                      {name}
                    </td>
                    <td className="py-0.5 pr-2 font-mono text-gray-500">
                      {tr.message_count ?? '—'}
                    </td>
                    <td
                      className="cursor-help py-0.5 pr-2 font-mono text-gray-500"
                      title={
                        tr.continuity_definition ??
                        'No continuity definition provided by the pipeline.'
                      }
                    >
                      {formatContinuity(tr.continuity)} ⓘ
                    </td>
                    <td
                      className={`py-0.5 font-mono ${
                        majors > 0
                          ? 'font-semibold text-red-600'
                          : events.length > 0
                            ? 'text-amber-600'
                            : 'text-gray-500'
                      }`}
                    >
                      {events.length}
                      {majors > 0 ? ` (${majors} major)` : ''}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {report.skipped_topics && Object.keys(report.skipped_topics).length > 0 && (
            <details className="text-[11px] text-gray-500">
              <summary className="cursor-pointer">
                Skipped topics ({Object.keys(report.skipped_topics).length})
              </summary>
              <ul className="mt-1 flex flex-col gap-0.5">
                {Object.entries(report.skipped_topics).map(([t, reason]) => (
                  <li key={t} className="font-mono">
                    <span className="text-gray-600">{t}</span>
                    <span className="text-gray-400"> — {reason}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
