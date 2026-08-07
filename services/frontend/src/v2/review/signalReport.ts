// Pure transforms for the Review "Data integrity" section: signal_report
// sidecar payloads -> the aggregated loss timeline + event/summary rows, and
// the linear timeline<->video sync math. Kept DOM-free so the aggregation and
// sync are unit-testable without React or a <video>.

import type { SignalReport, SignalTopicReport } from '../../api/types';

// ---- Timeline <-> video sync ------------------------------------------------
// The synced video is the full-length encode (max_frames:0): video time 0..D
// maps linearly onto the episode-GLOBAL axis 0..spanNs. Fraction-based so a
// differing D and span still line up, and it clamps to the valid range.

/** A global-axis instant (ns) -> synced-video currentTime (s). */
export function globalNsToVideoSeconds(
  globalNs: number,
  spanNs: number,
  durationS: number,
): number {
  if (spanNs <= 0 || durationS <= 0) return 0;
  const frac = Math.min(1, Math.max(0, globalNs / spanNs));
  return frac * durationS;
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
 * The colour category for one timeline bin: gray outside the topic's active
 * range; red when a MAJOR event overlaps the bin OR (`emptyIsLoss` only) the
 * bin is empty inside the active range; amber when a MINOR event overlaps;
 * otherwise green (= no evidence of loss).
 *
 * `emptyIsLoss` exists because "empty bin = red" is only honest for a topic
 * that normally FILLS its bins: measured on a real recording, the backend's
 * fixed-count grid gave ~10 ms bins against 20–30 ms message periods, so most
 * bins of a perfectly healthy topic are legitimately empty — painting those
 * red screamed loss where none was measured. Sparse topics rely on the
 * backend's inferred loss_events (1.5× median-interval rule) instead.
 */
export function binColor(args: {
  binIndex: number;
  binNs: number;
  density: number;
  activeStartNs: number;
  activeEndNs: number;
  lossEvents: LossEvent[];
  /** Treat an empty in-range bin as loss (dense topics only); default false. */
  emptyIsLoss?: boolean;
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
  if (overlapsSeverity('major') || (args.emptyIsLoss === true && args.density === 0)) {
    return 'red';
  }
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

/**
 * A topic's empty bin only counts as loss when its typical occupied bin holds
 * at least this many messages — then an empty bin is a ≥3× median-interval
 * hole, comfortably beyond the backend's own 1.5× loss threshold (so the red
 * corroborates measurement rather than inventing it).
 */
export const EMPTY_RED_MIN_MEDIAN = 3;

// ---- Aggregated integrity timeline -------------------------------------------
// ONE lane under the synced video instead of a per-topic grid: every bin shows
// the WORST condition across all topics at that instant, and the tooltip names
// which topics degraded. Per-topic detail lives in the event table below.

/** One bin of the aggregated timeline. */
export interface AggregateBin {
  /** Bin start on the global axis (ns). */
  startNs: number;
  binNs: number;
  /** Worst per-topic bin colour at this instant (red > amber > green > gray). */
  color: BinColor;
  /** Topics red/amber in this bin — the tooltip's "what degraded here". */
  degraded: string[];
}

const SEVERITY_RANK: Record<BinColor, number> = { gray: 0, green: 1, amber: 2, red: 3 };

/**
 * Collapse every topic's density bins into the single worst-severity lane.
 * Topics without bins (< 2 messages) don't participate; their loss events (if
 * any) still show in the event table. Empty when the sidecar carries no global
 * span or no binned topic (v1.0 sidecar) — the caller renders nothing (honest).
 */
export function aggregateBins(report: SignalReportExt): AggregateBin[] {
  const spanNs = episodeSpanNs(report);
  const topics = Object.entries(report.topics).filter(([, t]) => t.bins);
  if (spanNs <= 0 || topics.length === 0) return [];
  // Bins are fixed-count across the shared global span, so every topic's grid
  // is the same; the first topic defines it. Per topic, decide once whether an
  // empty bin is evidence of loss (dense topics only — see binColor).
  const grid = topics[0]![1].bins!;
  const emptyIsLoss = new Map(
    topics.map(([name, t]) => [
      name,
      medianNonZero(t.bins!.densities) >= EMPTY_RED_MIN_MEDIAN,
    ]),
  );
  const out: AggregateBin[] = [];
  for (let i = 0; i < grid.densities.length; i++) {
    let worst: BinColor = 'gray';
    const degraded: string[] = [];
    for (const [name, t] of topics) {
      const bins = t.bins!;
      if (i >= bins.densities.length) continue;
      const [activeStart, activeEnd] = topicActiveRangeNs(t, spanNs);
      const c = binColor({
        binIndex: i,
        binNs: bins.bin_ns,
        density: bins.densities[i]!,
        activeStartNs: activeStart,
        activeEndNs: activeEnd,
        lossEvents: t.loss_events ?? [],
        emptyIsLoss: emptyIsLoss.get(name)!,
      });
      if (SEVERITY_RANK[c] > SEVERITY_RANK[worst]) worst = c;
      if (c === 'amber' || c === 'red') degraded.push(name);
    }
    out.push({ startNs: i * grid.bin_ns, binNs: grid.bin_ns, color: worst, degraded });
  }
  return out;
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
