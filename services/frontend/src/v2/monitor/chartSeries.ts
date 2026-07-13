// Multi-topic overlay helpers for the Monitor frequency chart — the selection
// set, palette, label disambiguation, and x-axis alignment that give the v2
// Monitor the same overlay capability the v1 Graph tab had (the user's "can't
// overlay the monitor graph" complaint). Kept as pure functions so the
// alignment / label / toggle logic is unit-testable without a canvas.

import type { MetricSample } from '../../features/graph/useMetricHistory';

// v1 GraphTab's palette (src/features/graph/GraphTab.tsx) — distinct line colours
// assigned by series order, so a chart never draws two topics in one colour. The
// 6-colour length is also the overlay cap (v1's MAX_SERIES).
export const PALETTE = ['#0d9488', '#0891b2', '#d97706', '#fb7185', '#16a34a', '#7c3aed'];
export const MAX_SERIES = PALETTE.length;

export function paletteColor(i: number): string {
  return PALETTE[i % PALETTE.length] ?? PALETTE[0]!;
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

export interface AlignedHz {
  /** x axis in SECONDS (the uPlot time scale), the sorted union of sample times. */
  xs: number[];
  /** one Hz column per input topic, aligned to `xs`, null where a topic has no
   *  sample at that tick. */
  cols: (number | null)[][];
}

// Build the uPlot data columns for N overlaid topics. All topics normally carry
// the same `t` per SSE tick, but a topic that started late or dropped out misses
// ticks — so the x axis is the sorted UNION of every selected topic's sample
// times and each column is null-filled where it has no sample (uPlot then draws
// a gap rather than a false interpolation). Column order matches `topics` order
// so it lines up with paletteColor(i) and the legend.
export function alignHzSeries(
  topics: string[],
  history: Map<string, MetricSample[]>,
): AlignedHz {
  const tset = new Set<number>();
  for (const topic of topics) {
    for (const s of history.get(topic) ?? []) tset.add(s.t);
  }
  const times = [...tset].sort((a, b) => a - b);
  const indexOfT = new Map<number, number>();
  times.forEach((t, i) => indexOfT.set(t, i));
  const cols = topics.map((topic) => {
    const col: (number | null)[] = new Array(times.length).fill(null);
    for (const s of history.get(topic) ?? []) {
      const i = indexOfT.get(s.t);
      if (i !== undefined) col[i] = s.hz;
    }
    return col;
  });
  return { xs: times.map((t) => t / 1000), cols };
}
