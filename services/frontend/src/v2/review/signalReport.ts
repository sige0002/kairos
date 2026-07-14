// Pure transforms for the Review Signals section: signal_report topic payloads
// -> uPlot AlignedData, and the linear chart<->video sync math. Kept DOM-free so
// the mapping and sync are unit-testable without uPlot or a <video>.

import type { SignalTopicReport } from '../../api/types';

/**
 * Elapsed seconds from the first sample (0-based). We always subtract t[0], so
 * this is correct whether the backend's `t_ns` is episode-relative (already
 * ~0-based, the documented shape) or absolute — and 0-based keeps the numbers
 * well within JS float precision for the chart's x-axis.
 */
export function elapsedSeconds(tNs: number[]): number[] {
  if (tNs.length === 0) return [];
  const t0 = tNs[0]!;
  return tNs.map((t) => (t - t0) / 1e9);
}

/** Episode span (seconds) a topic's samples cover; 0 when fewer than 2 points. */
export function episodeSpanSec(tNs: number[]): number {
  if (tNs.length < 2) return 0;
  return (tNs[tNs.length - 1]! - tNs[0]!) / 1e9;
}

/** The field paths of a topic that carry a (possibly all-null) sample array. */
export function numericFieldPaths(topic: SignalTopicReport): string[] {
  return Object.keys(topic.fields ?? {});
}

export interface UplotSeriesData {
  /** uPlot AlignedData: [xsSeconds, ...ysPerField]. */
  data: (number | null)[][];
  /** Field paths in the same order as the y-columns (only those that exist). */
  fields: string[];
}

/**
 * uPlot AlignedData for the selected fields of one topic: x = elapsed seconds
 * (0-based), one y-column per selected field. Selections not present in the
 * payload are dropped; a field array shorter/longer than x is padded/trimmed so
 * uPlot never reads a mismatched column.
 */
export function signalToUplot(
  topic: SignalTopicReport,
  selected: string[],
): UplotSeriesData {
  const xs = elapsedSeconds(topic.t_ns ?? []);
  const fields = selected.filter((f) => f in (topic.fields ?? {}));
  const ys = fields.map((f) => {
    const col = topic.fields[f] ?? [];
    if (col.length === xs.length) return col;
    if (col.length > xs.length) return col.slice(0, xs.length);
    return [...col, ...Array<number | null>(xs.length - col.length).fill(null)];
  });
  return { data: [xs, ...ys], fields };
}

// ---- Chart <-> video sync ---------------------------------------------------
// The synced video is the full-length encode (max_frames:0): video time 0..D
// maps linearly to chart elapsed 0..spanSec. Fraction-based so a differing D and
// spanSec still line up, and both directions clamp to their valid range.

/** Video currentTime (s) -> chart elapsed x (s). */
export function videoTimeToChartX(
  currentTime: number,
  duration: number,
  spanSec: number,
): number {
  if (duration <= 0 || spanSec <= 0) return 0;
  const frac = Math.min(1, Math.max(0, currentTime / duration));
  return frac * spanSec;
}

/** Chart elapsed x (s) -> video currentTime (s). */
export function chartXToVideoTime(
  chartX: number,
  spanSec: number,
  duration: number,
): number {
  if (spanSec <= 0 || duration <= 0) return 0;
  const frac = Math.min(1, Math.max(0, chartX / spanSec));
  return frac * duration;
}

/** Continuity as a compact percentage; "n/a" when null/undefined/NaN. */
export function formatContinuity(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return 'n/a';
  return `${(v * 100).toFixed(0)}%`;
}
