// Signals section of the Review detail (RunInspection). Runs the dora
// `signal_report` pipeline (per-topic decoded numeric fields over episode time),
// then plots the selected fields with the shared uPlot wrapper — the same dotted
// field-path vocabulary as the live Probe view. Optionally syncs a full-length
// video_check mp4 to the chart: the video clock drives a playhead line on the
// chart, and click/drag on the chart seeks the video.
//
// Honest degradation (HCD): nothing auto-runs (an explicit button, like the loss
// report); a running job shows progress; a failed/absent pipeline says so
// plainly; a recording with no numeric topics says so and lists what was
// skipped; continuity is shown WITH its formula (tooltip) and as "n/a" when
// null. The playhead/seek only engage on a FULL-LENGTH video — a head-only
// preview would map the whole chart onto its first frames, which would lie.

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { apiGet, apiPost } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type {
  JobResult,
  JobStatus,
  RunTopic,
  VideoCheckSummary,
} from '../../api/types';
import { ErrorMessage } from '../../components/ErrorMessage';
import { PALETTE, UplotChart, type UplotSeriesConf } from '../../features/probe/UplotChart';
import { TERMINAL, VideoPlayer, cameraTopics } from '../../features/inspect/inspect';
import {
  chartXToVideoTime,
  episodeSpanSec,
  formatContinuity,
  globalNsToChartSec,
  numericFieldPaths,
  type SignalReportExt,
  signalToUplot,
  videoTimeToChartX,
} from './signalReport';
import { SignalHeatmap } from './SignalHeatmap';
import { LossEventList } from './LossEventList';
import {
  applyDefaults,
  loadSignalDefaults,
  partitionFields,
  type SignalDefaults,
} from './signalDefaults';

// Run the signal_report pipeline (one shot) and return its parsed summary. Same
// POST /jobs → poll status → fetch result lifecycle the VideoPlayer uses, so a
// missing/failed pipeline surfaces as an honest error instead of a dead chart.
function useSignalReport(runId: string) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [report, setReport] = useState<SignalReportExt | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      apiPost<JobStatus>('/jobs', {
        pipeline: 'signal_report',
        run_id: runId,
        params: { topics: null, max_points: 2000 },
      }),
    onSuccess: (job) => {
      setReport(null);
      setJobError(null);
      setJobId(job.job_id);
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
          let message = `Signal report ${status.state}.`;
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

export function SignalSection({ runId, topics }: { runId: string; topics: RunTopic[] }) {
  const sig = useSignalReport(runId);
  const report = sig.report;

  const [topic, setTopic] = useState<string | null>(null);
  const [fields, setFields] = useState<string[]>([]);
  const [syncCamera, setSyncCamera] = useState<string | null>(null);
  const cameras = cameraTopics(topics);
  const [cameraChoice, setCameraChoice] = useState<string>(cameras[0]?.name ?? '');

  // Video sync state, shared with the embedded VideoPlayer.
  const [videoDur, setVideoDur] = useState(0);
  const [videoTruncated, setVideoTruncated] = useState(false);
  const [playheadX, setPlayheadX] = useState<number | null>(null);
  const [seekTo, setSeekTo] = useState<{ seconds: number; nonce: number } | null>(null);

  const numericTopics = report ? Object.keys(report.topics) : [];

  // Per-robot display defaults (S1'): loaded once; loadSignalDefaults falls back
  // to the built-ins on any error, so `defaults` is only null while in flight.
  // Seeding waits for it so the YAML-configured selection wins over a race.
  const [defaults, setDefaults] = useState<SignalDefaults | null>(null);
  const [showAllFields, setShowAllFields] = useState(false);
  useEffect(() => {
    let alive = true;
    loadSignalDefaults().then((d) => {
      if (alive) setDefaults(d);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Seed / re-validate the selected topic when a report lands: keep a still-valid
  // manual choice, otherwise open on the YAML-configured default topic.
  useEffect(() => {
    if (!defaults) return;
    const ts = report ? Object.keys(report.topics) : [];
    setTopic((prev) =>
      prev && ts.includes(prev)
        ? prev
        : report
          ? applyDefaults(report, defaults).topic
          : null,
    );
  }, [report, defaults]);

  const topicReport = topic && report ? report.topics[topic] : undefined;

  // Seed / re-validate the selected fields for the current topic: keep the
  // user's still-valid picks, otherwise apply the msg_type rule for THIS topic
  // (defaultTopic pinned so applyDefaults resolves fields for it), falling back
  // to the first non-hidden leaves. Keyed on report + topic so switching reseeds.
  useEffect(() => {
    if (!defaults) return;
    const tr = topic && report ? report.topics[topic] : undefined;
    const af = tr ? numericFieldPaths(tr) : [];
    setFields((prev) => {
      const valid = prev.filter((f) => af.includes(f));
      if (valid.length > 0) return valid;
      if (report && topic) {
        return applyDefaults(report, { ...defaults, defaultTopic: topic }).fields;
      }
      return af.slice(0, 1);
    });
  }, [report, topic, defaults]);

  const allFields = topicReport ? numericFieldPaths(topicReport) : [];
  // "Show all fields" reveals YAML-hidden paths (header.* by default); a
  // selected hidden field always stays visible so its series can be untoggled.
  const { visible: visibleFields, hidden: hiddenFields } = partitionFields(
    allFields,
    fields,
    defaults?.hiddenFieldPatterns ?? [],
  );
  const fieldChoices = showAllFields ? [...visibleFields, ...hiddenFields] : visibleFields;
  const spanSec = topicReport ? episodeSpanSec(topicReport.t_ns ?? []) : 0;
  const fieldsKey = fields.join('|');
  const { data, fields: plotFields } = useMemo(
    () =>
      topicReport
        ? signalToUplot(topicReport, fields)
        : { data: [[]] as (number | null)[][], fields: [] as string[] },
    // fieldsKey stands in for the fields array identity (fields is read inside).
    [topicReport, fieldsKey, fields],
  );
  const uplotSeries: UplotSeriesConf[] = plotFields.map((f, i) => ({
    label: f,
    stroke: PALETTE[i % PALETTE.length]!,
  }));

  // Sync is honest only for a full-length video (covers the whole episode).
  const syncEnabled = !!syncCamera && !videoTruncated && videoDur > 0 && spanSec > 0;

  const onVideoTime = (currentTime: number, duration: number) => {
    if (Number.isFinite(duration) && duration > 0) setVideoDur(duration);
    if (duration > 0 && spanSec > 0)
      setPlayheadX(videoTimeToChartX(currentTime, duration, spanSec));
  };
  const onVideoSummary = (s: VideoCheckSummary) => {
    setVideoTruncated(!!s.truncated);
    if (s.duration_s != null) setVideoDur(s.duration_s);
  };
  const onChartSeek = (xVal: number) => {
    setPlayheadX(xVal); // immediate feedback; the video's timeupdate confirms it
    setSeekTo({ seconds: chartXToVideoTime(xVal, spanSec, videoDur), nonce: Date.now() });
  };

  // Seek from the heatmap / event list, which speak the episode-GLOBAL axis:
  // map the clicked global time into the CHARTED topic's chart-elapsed seconds
  // (accounting for its start_offset_ns, so a click on another topic's row still
  // lands on the charted playhead), move the playhead, and — when a full-length
  // video is synced — seek it the same way the chart's own click does.
  const onSeekGlobal = (globalNs: number) => {
    const chartX = globalNsToChartSec(globalNs, topicReport?.start_offset_ns ?? 0);
    setPlayheadX(Math.min(spanSec, Math.max(0, chartX)));
    if (syncEnabled) {
      setSeekTo({ seconds: chartXToVideoTime(chartX, spanSec, videoDur), nonce: Date.now() });
    }
  };

  const toggleField = (f: string) =>
    setFields((prev) =>
      prev.includes(f) ? prev.filter((x) => x !== f) : [...prev, f],
    );

  return (
    <section data-testid="review-signals">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-[12.5px] font-medium text-gray-700">Signals</h4>
        <button
          type="button"
          data-testid="review-run-signal"
          onClick={sig.run}
          disabled={sig.running}
          className="rounded-control border border-teal-200 px-2.5 py-1 text-[11.5px] font-semibold text-teal-700 transition-colors hover:bg-teal-50 disabled:opacity-50"
        >
          {sig.running ? 'Generating…' : report ? 'Re-run signal report' : 'Run signal report'}
        </button>
      </div>

      {sig.error && <ErrorMessage error={sig.error} />}
      {sig.jobError && (
        <p role="alert" className="text-[11.5px] text-red-600" data-testid="review-signal-error">
          {sig.jobError}
        </p>
      )}

      {!report && !sig.running && !sig.jobError && !sig.error && (
        <p className="text-[11.5px] text-gray-500">
          Decodes numeric fields (joint states, forces, …) over episode time and plots
          them — decoding stays isolated in the pipeline.
        </p>
      )}
      {sig.running && (
        <p className="text-[11.5px] text-gray-500" data-testid="review-signal-progress">
          Decoding numeric signals from the recording…
        </p>
      )}

      {report && numericTopics.length === 0 && (
        <p className="text-[11.5px] text-gray-500" data-testid="review-signal-empty">
          No numeric topics in this recording.
        </p>
      )}

      {report && numericTopics.length > 0 && topicReport && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="signal topic"
              data-testid="review-signal-topic"
              value={topic ?? ''}
              onChange={(e) => {
                setTopic(e.target.value || null);
                setFields([]);
              }}
              className="max-w-[220px] truncate rounded-control border border-gray-200 px-2 py-1 font-mono text-[11.5px] text-gray-700"
            >
              {numericTopics.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <span
              data-testid="review-signal-continuity"
              title={
                topicReport.continuity_definition ??
                'No continuity definition provided by the pipeline.'
              }
              className="cursor-help rounded-chip bg-gray-50 px-2 py-0.5 font-mono text-[11px] text-gray-500"
            >
              continuity {formatContinuity(topicReport.continuity)} ⓘ
            </span>
            {topicReport.downsample && topicReport.downsample.stride > 1 && (
              <span className="font-mono text-[11px] text-gray-400">
                ↓{topicReport.downsample.stride}× ({topicReport.downsample.points} pts)
              </span>
            )}
            {topicReport.time_source && (
              <span
                title="Clock rule the pipeline resolved for this topic"
                className="font-mono text-[11px] text-gray-400"
              >
                time: {topicReport.time_source}
              </span>
            )}
          </div>

          {allFields.length === 0 ? (
            <p className="text-[11.5px] text-gray-500">
              This topic carries no numeric fields.
            </p>
          ) : (
            <>
              <div
                data-testid="review-signal-fields"
                className="flex max-h-24 flex-wrap gap-x-3 gap-y-1 overflow-auto"
              >
                {fieldChoices.map((f) => (
                  <label
                    key={f}
                    className="flex items-center gap-1 font-mono text-[11px] text-gray-600"
                  >
                    <input
                      type="checkbox"
                      checked={fields.includes(f)}
                      onChange={() => toggleField(f)}
                      className="h-3 w-3 accent-teal-600"
                    />
                    {f}
                  </label>
                ))}
              </div>
              {hiddenFields.length > 0 && (
                <button
                  type="button"
                  data-testid="review-signal-show-all"
                  aria-expanded={showAllFields}
                  onClick={() => setShowAllFields((v) => !v)}
                  className="self-start text-[11px] text-gray-400 underline decoration-dotted transition-colors hover:text-gray-600"
                >
                  {showAllFields
                    ? 'Hide filtered fields'
                    : `Show all fields (${hiddenFields.length} hidden)`}
                </button>
              )}
            </>
          )}

          {/* Loss-location view (signal_report v1.1): stacked per-topic heatmap
              on the episode-global axis + a sortable event table, both seeking
              the charted playhead / synced video. Above the chart so the loss
              map reads as context for the signal below it. */}
          <div className="flex flex-col gap-1.5 border-t border-gray-100 pt-2">
            <SignalHeatmap
              report={report}
              selectedTopic={topic}
              onSelectTopic={(t) => {
                setTopic(t);
                setFields([]);
              }}
              onSeekGlobal={onSeekGlobal}
            />
            <LossEventList report={report} onSeekGlobal={onSeekGlobal} />
          </div>

          {plotFields.length > 0 ? (
            <UplotChart
              data={data}
              series={uplotSeries}
              height={200}
              xTime={false}
              playhead={playheadX}
              onSeek={syncEnabled ? onChartSeek : undefined}
            />
          ) : (
            <p className="text-[11.5px] text-gray-400">Select a field to plot.</p>
          )}

          {/* Synced video (event-driven): pick a camera, load it, and — once a
              full-length encode is available — the chart playhead tracks it and
              clicking the chart seeks it. */}
          {cameras.length > 0 && (
            <div className="flex flex-col gap-2 border-t border-gray-100 pt-2">
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
                      synced playback across the whole episode.
                    </p>
                  )}
                  <VideoPlayer
                    key={syncCamera}
                    runId={runId}
                    topic={syncCamera}
                    onTimeUpdate={onVideoTime}
                    onSummary={onVideoSummary}
                    seekTo={seekTo}
                  />
                  {syncEnabled && (
                    <p className="text-[11px] text-gray-400">
                      Playhead follows the video; click or drag the chart to seek.
                    </p>
                  )}
                </>
              )}
            </div>
          )}

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
