// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Multi-topic overlay + metric helpers for the Monitor frequency chart — the
// metric registry, selection set, palette, label disambiguation, and x-axis
// alignment that give the v2 Monitor the same capability the v1 Graph tab had
// (metric switching + multi-topic overlay). Kept as pure functions so the
// registry / alignment / window / label / toggle logic is unit-testable without
// a canvas.

import type { MetricSample } from '../../features/graph/useMetricHistory';

// v1 GraphTab's palette (src/features/graph/GraphTab.tsx) — distinct line colours
// assigned by series order, so a chart never draws two topics in one colour. The
// 6-colour length is also the overlay cap (v1's MAX_SERIES).
export const PALETTE = ['#0d9488', '#0891b2', '#d97706', '#fb7185', '#16a34a', '#7c3aed'];
export const MAX_SERIES = PALETTE.length;

export function paletteColor(i: number): string {
  return PALETTE[i % PALETTE.length] ?? PALETTE[0]!;
}

// --- Metric registry ------------------------------------------------------
// The exact set the non-intrusive monitor can actually produce, ported 1:1 from
// v1 GraphTab's METRICS (latency/loss were dropped there for the same reason:
// with raw=True the monitor never decodes payloads, so stamp_delay/loss_rate are
// never populated — a permanently-empty chart is worse than none). Switching
// metric is a data-SELECTION change over the same MetricSample buffer, not new
// plumbing (each MetricSample already carries hz/bw/gap/rate).

export type MonitorMetricKey = 'hz' | 'bw' | 'gap' | 'rate';

export interface MonitorMetricDef {
  key: MonitorMetricKey;
  /** Full label for the selector. */
  label: string;
  /** Short axis/legend unit. */
  unit: string;
  /** Pull this metric's value out of an accumulated sample. */
  select: (s: MetricSample) => number | null;
  /** Legend/footer value precision. */
  digits: number;
  /** Shown inside the chart when the metric has no data (e.g. why rate is
   *  empty) rather than leaving a blank panel — honesty principle. */
  note?: string;
  /** Whether the expected_hz / warn-below footer stats apply (hz only). */
  hzLike?: boolean;
}

export const MONITOR_METRICS: MonitorMetricDef[] = [
  { key: 'hz', label: 'Frequency', unit: 'Hz', select: (s) => s.hz, digits: 1, hzLike: true },
  { key: 'bw', label: 'Bandwidth', unit: 'MB/s', select: (s) => s.bw, digits: 2 },
  { key: 'gap', label: 'Max gap', unit: 'ms', select: (s) => s.gap, digits: 0 },
  {
    key: 'rate',
    label: 'Rate vs expected',
    unit: '%',
    select: (s) => s.rate,
    digits: 0,
    note: 'Only computed for topics with expected_hz set.',
  },
];

export function metricDef(key: MonitorMetricKey): MonitorMetricDef {
  return MONITOR_METRICS.find((m) => m.key === key) ?? MONITOR_METRICS[0]!;
}

// --- Time windows ---------------------------------------------------------
// Same 30s / 1m / 5m set the v1 Graph tab (and Live Scope) offered.
export type MonitorWindowId = '30s' | '1m' | '5m';
export const MONITOR_WINDOWS: { id: MonitorWindowId; label: string; ms: number }[] = [
  { id: '30s', label: '30s', ms: 30_000 },
  { id: '1m', label: '1m', ms: 60_000 },
  { id: '5m', label: '5m', ms: 300_000 },
];

export function windowMs(id: MonitorWindowId): number {
  return MONITOR_WINDOWS.find((w) => w.id === id)?.ms ?? 60_000;
}

export function shortName(topic: string): string {
  const parts = topic.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? topic;
}

// Disambiguate labels: the shortest trailing path segment(s) unique across the
// set, so two topics ending `/image` (or `/compressed`) don't collapse to the
// same label. Ported from v1 GraphTab.buildLabelMap; falls back to the full path.
export function buildLabelMap(topics: string[]): Map<string, string> {
  const tail = (t: string, n: number) => t.split('/').filter(Boolean).slice(-n).join('/') || t;
  const maxDepth = Math.max(1, ...topics.map((t) => t.split('/').filter(Boolean).length));
  const map = new Map<string, string>();
  for (const t of topics) {
    let label = t; // fall back to the full path if nothing shorter is unique
    for (let d = 1; d <= maxDepth; d++) {
      const cand = tail(t, d);
      if (!topics.some((o) => o !== t && tail(o, d) === cand)) {
        label = cand;
        break;
      }
    }
    map.set(t, label);
  }
  return map;
}

// Toggle a topic in/out of the charted set, preserving order (so palette colours
// stay stable as topics are added) and enforcing the MAX_SERIES cap. Adding while
// already at the cap is a no-op — the caller surfaces the "6/6" note.
export function toggleTopic(selected: string[], name: string): string[] {
  if (selected.includes(name)) return selected.filter((t) => t !== name);
  if (selected.length >= MAX_SERIES) return selected;
  return [...selected, name];
}

export interface AlignedSeries {
  /** x axis in SECONDS (the uPlot time scale), the sorted union of sample times. */
  xs: number[];
  /** one metric column per input topic, aligned to `xs`, null where a topic has
   *  no sample at that tick. */
  cols: (number | null)[][];
}

// Build the uPlot data columns for N overlaid topics on ONE metric. All topics
// normally carry the same `t` per SSE tick, but a topic that started late or
// dropped out misses ticks — so the x axis is the sorted UNION of every selected
// topic's sample times and each column is null-filled where it has no sample
// (uPlot then draws a gap rather than a false interpolation). Column order
// matches `topics` order so it lines up with paletteColor(i) and the legend.
//
// `select` picks the metric field; pass a `window` to keep only samples within
// [nowMs - ms, ∞) (the visible time window) before aligning — trimming here
// keeps the x-union small and the chart scrolls with the window.
export function alignMetricSeries(
  topics: string[],
  history: Map<string, MetricSample[]>,
  select: (s: MetricSample) => number | null,
  window?: { ms: number; nowMs: number },
): AlignedSeries {
  const cutoff = window ? window.nowMs - window.ms : -Infinity;
  const perTopic = topics.map((t) => (history.get(t) ?? []).filter((s) => s.t >= cutoff));

  const tset = new Set<number>();
  for (const arr of perTopic) for (const s of arr) tset.add(s.t);
  const times = [...tset].sort((a, b) => a - b);
  const indexOfT = new Map<number, number>();
  times.forEach((t, i) => indexOfT.set(t, i));
  const cols = perTopic.map((arr) => {
    const col: (number | null)[] = new Array(times.length).fill(null);
    for (const s of arr) {
      const i = indexOfT.get(s.t);
      if (i !== undefined) col[i] = select(s);
    }
    return col;
  });
  return { xs: times.map((t) => t / 1000), cols };
}

// Back-compat thin wrapper (the Hz overlay's original entry point; still used by
// unit tests). Equivalent to alignMetricSeries on the `hz` field, no window.
export function alignHzSeries(
  topics: string[],
  history: Map<string, MetricSample[]>,
): AlignedSeries {
  return alignMetricSeries(topics, history, (s) => s.hz);
}

/** Whether any column carries at least one non-null value (i.e. the metric has
 *  data to plot) — drives the in-chart "why is this empty" note. */
export function hasAnyValue(cols: (number | null)[][]): boolean {
  return cols.some((col) => col.some((v) => v != null));
}
