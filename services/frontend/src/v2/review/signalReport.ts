// Pure transforms for the Review Signals section: signal_report topic payloads
// -> uPlot AlignedData, and the linear chart<->video sync math. Kept DOM-free so
// the mapping and sync are unit-testable without uPlot or a <video>.

import type { SignalReport, SignalTopicReport } from '../../api/types';

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

// ---- Loss-location view (signal_report v1.1) --------------------------------
// The sidecar gained loss events, per-topic edges, and density bins, all on an
// EPISODE-GLOBAL relative axis (offsets from the earliest full-res timestamp
// across every included topic — small, JS-safe). These types extend the base
// api/types shapes additively (older sidecars simply omit the fields), and the
// helpers below stay DOM-free so the heatmap colour rules / overlap detection /
// global↔chart↔video time mapping are unit-testable without React.

/** One inferred gap on the global axis (start/duration in ns from global zero). */
export interface LossEvent {
  start_ns: number;
  duration_ns: number;
  estimated_lost: number;
  severity: 'major' | 'minor';
}

/** How far a topic's own range sits inside the global span (ns). */
export interface TopicEdges {
  start_delay_ns: number;
  end_early_ns: number;
}

/** Fixed-count message-density bins across the global span. */
export interface TopicBins {
  count: number;
  bin_ns: number;
  densities: number[];
}

/** A signal_report topic plus its v1.1 global-axis loss fields. */
export interface SignalTopicReportExt extends SignalTopicReport {
  /** Topic's first timestamp − global zero (ns on the global axis). */
  start_offset_ns?: number;
  loss_events?: LossEvent[];
  /** Count of events dropped past the per-topic cap (largest kept). */
  loss_events_truncated?: number;
  edges?: TopicEdges;
  /** null for a topic with < 2 messages (no axis to bin against). */
  bins?: TopicBins | null;
}

/** A signal_report summary plus the top-level global span. */
export interface SignalReportExt extends SignalReport {
  span?: { duration_ns?: number } | null;
  topics: Record<string, SignalTopicReportExt>;
}

export type BinColor = 'gray' | 'green' | 'amber' | 'red';

/** Global span (ns) the loss view is laid out on; 0 when absent/unknown. */
export function episodeSpanNs(report: SignalReportExt): number {
  return report.span?.duration_ns ?? 0;
}

/**
 * The topic's OWN active range on the global axis, as `[startNs, endNs]`:
 * `start_offset_ns` .. `span − end_early_ns`. Bins outside this are the topic's
 * silence before it began / after it stopped (rendered gray, never as loss).
 */
export function topicActiveRangeNs(
  topic: SignalTopicReportExt,
  spanNs: number,
): [number, number] {
  const start = topic.start_offset_ns ?? 0;
  const end = spanNs - (topic.edges?.end_early_ns ?? 0);
  return [start, end];
}

/** Half-open overlap test: do `[aStart, aEnd)` and `[bStart, bEnd)` intersect? */
export function intervalsOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * The colour category for one heatmap bin, exactly per the L1 rules:
 * gray outside the topic's active range; red when a MAJOR event overlaps the
 * bin OR the bin is empty (density 0) inside the active range; amber when a
 * MINOR event overlaps; otherwise green (ok).
 */
export function binColor(args: {
  binIndex: number;
  binNs: number;
  density: number;
  activeStartNs: number;
  activeEndNs: number;
  lossEvents: LossEvent[];
}): BinColor {
  const binStart = args.binIndex * args.binNs;
  const binEnd = binStart + args.binNs;
  if (!intervalsOverlap(binStart, binEnd, args.activeStartNs, args.activeEndNs)) {
    return 'gray';
  }
  const overlapsSeverity = (sev: 'major' | 'minor') =>
    args.lossEvents.some(
      (e) =>
        e.severity === sev &&
        intervalsOverlap(binStart, binEnd, e.start_ns, e.start_ns + e.duration_ns),
    );
  if (overlapsSeverity('major') || args.density === 0) return 'red';
  if (overlapsSeverity('minor')) return 'amber';
  return 'green';
}

/** Median of the strictly-positive densities (the topic's ok baseline); 0 if none. */
export function medianNonZero(densities: number[]): number {
  const nz = densities.filter((d) => d > 0).sort((a, b) => a - b);
  if (nz.length === 0) return 0;
  const mid = Math.floor(nz.length / 2);
  return nz.length % 2 === 0 ? (nz[mid - 1]! + nz[mid]!) / 2 : nz[mid]!;
}

/** A green bin's fill fraction (0..1) relative to the topic's median-nonzero bin. */
export function greenIntensity(density: number, medianNonZero: number): number {
  if (medianNonZero <= 0) return 1;
  return Math.min(1, Math.max(0, density / medianNonZero));
}

/**
 * A global-axis time (ns) → the CHARTED topic's chart-elapsed seconds, by
 * subtracting that topic's `start_offset_ns`. May be <0 or >spanSec when the
 * clicked bin lies outside the charted topic's own range; the video-sync
 * helpers clamp it. This is what lets a click on another topic's row still seek
 * the charted topic's playhead + the synced video.
 */
export function globalNsToChartSec(globalNs: number, chartStartOffsetNs: number): number {
  return (globalNs - chartStartOffsetNs) / 1e9;
}

/** One loss event flattened with its topic, for the aggregate event table. */
export interface LossRow extends LossEvent {
  topic: string;
}

/** Every topic's loss events flattened and sorted by global start time. */
export function collectLossRows(report: SignalReportExt): LossRow[] {
  const rows: LossRow[] = [];
  for (const [topic, tr] of Object.entries(report.topics)) {
    for (const e of tr.loss_events ?? []) rows.push({ topic, ...e });
  }
  rows.sort((a, b) => a.start_ns - b.start_ns);
  return rows;
}

/** A subtle edge-effect row (topic started late / stopped early). */
export interface EdgeRow {
  topic: string;
  kind: 'start_delay' | 'end_early';
  /** Where on the global axis the edge sits (ns) — the seek target. */
  globalNs: number;
  durationNs: number;
}

/** Nonzero start-delay / ended-early edges across topics, sorted by global time. */
export function collectEdgeRows(report: SignalReportExt): EdgeRow[] {
  const span = episodeSpanNs(report);
  const rows: EdgeRow[] = [];
  for (const [topic, tr] of Object.entries(report.topics)) {
    const startDelay = tr.edges?.start_delay_ns ?? 0;
    const endEarly = tr.edges?.end_early_ns ?? 0;
    if (startDelay > 0) {
      rows.push({ topic, kind: 'start_delay', globalNs: 0, durationNs: startDelay });
    }
    if (endEarly > 0) {
      rows.push({ topic, kind: 'end_early', globalNs: span - endEarly, durationNs: endEarly });
    }
  }
  rows.sort((a, b) => a.globalNs - b.globalNs);
  return rows;
}

/** Total loss events dropped past the per-topic cap, across all topics. */
export function totalLossTruncated(report: SignalReportExt): number {
  return Object.values(report.topics).reduce(
    (sum, t) => sum + (t.loss_events_truncated ?? 0),
    0,
  );
}

/** A global-axis ns duration as a compact label ("420ms" / "1.35s"). */
export function formatNsShort(ns: number): string {
  if (ns < 1e9) return `${Math.round(ns / 1e6)}ms`;
  return `${(ns / 1e9).toFixed(2)}s`;
}

/** A global-axis instant (ns) as elapsed seconds ("4.20s"). */
export function formatSecondsShort(ns: number): string {
  return `${(ns / 1e9).toFixed(2)}s`;
}
