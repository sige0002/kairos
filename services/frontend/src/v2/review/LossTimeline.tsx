// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Aggregated integrity timeline for the Review "Data integrity" section: ONE
// lane on the episode-global axis directly under the synced video, acting as an
// annotated scrubber. Each bin is the WORST condition across every topic at
// that instant (green ok / amber minor loss / red major loss or silence inside
// a topic's active range / gray nothing active); hovering names the degraded
// topics; clicking seeks the synced video to that instant (only when a
// full-length video is loaded — a head-only preview would lie). A thin playhead
// line tracks the video clock. Per-topic detail lives in the event table below,
// not here. Pure divs, no chart lib.

import {
  type AggregateBin,
  type BinColor,
  type SignalReportExt,
  aggregateBins,
  episodeSpanNs,
  formatSecondsShort,
} from './signalReport';

const COLOR_CLASS: Record<BinColor, string> = {
  gray: 'bg-surface-muted',
  green: 'bg-status-success-accent',
  amber: 'bg-status-warning-accent',
  red: 'bg-status-danger-accent',
};

function binTitle(bin: AggregateBin): string {
  const what =
    bin.degraded.length > 0
      ? bin.degraded.join(', ')
      : bin.color === 'gray'
        ? 'no topic active'
        : 'all topics ok';
  return `${formatSecondsShort(bin.startNs)} · ${what}`;
}

/**
 * Renders nothing (honest) when the sidecar carries no global span / bins
 * (v1.0 sidecar). `playheadFrac` is the video clock as a 0..1 fraction of the
 * episode (null hides the playhead); `onSeekGlobal` receives a global-axis ns.
 */
export function LossTimeline({
  report,
  playheadFrac,
  seekEnabled,
  onSeekGlobal,
}: {
  report: SignalReportExt;
  playheadFrac: number | null;
  seekEnabled: boolean;
  onSeekGlobal: (globalNs: number) => void;
}) {
  const spanNs = episodeSpanNs(report);
  const bins = aggregateBins(report);
  if (spanNs <= 0 || bins.length === 0) return null;

  return (
    <div data-testid="review-loss-timeline" className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.04em] text-text-muted">
          Integrity timeline
        </h3>
        <span className="font-mono text-[10px] text-text-muted">
          span {formatSecondsShort(spanNs)}
        </span>
      </div>
      <div className="relative">
        <div
          className="grid h-4 overflow-hidden rounded-[3px]"
          style={{ gridTemplateColumns: `repeat(${bins.length}, 1fr)` }}
        >
          {bins.map((bin) => (
            <button
              key={bin.startNs}
              type="button"
              data-testid="timeline-bin"
              data-color={bin.color}
              disabled={!seekEnabled}
              title={binTitle(bin)}
              onClick={() => onSeekGlobal(bin.startNs)}
              className={`h-full ${COLOR_CLASS[bin.color]} ${
                seekEnabled ? 'cursor-pointer' : 'cursor-default'
              }`}
            />
          ))}
        </div>
        {playheadFrac != null && (
          <div
            data-testid="timeline-playhead"
            className="pointer-events-none absolute inset-y-0 w-px bg-text-primary/70"
            style={{ left: `${Math.min(1, Math.max(0, playheadFrac)) * 100}%` }}
          />
        )}
      </div>
      <span className="text-[10px] text-text-muted">
        green ok · amber minor loss · red major loss / silent · gray no topic active
        {seekEnabled ? ' — click to seek the video' : ''}
      </span>
    </div>
  );
}
