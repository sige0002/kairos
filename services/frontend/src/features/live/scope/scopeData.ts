// Pure data helpers for the Live Scope band's Health panels: turn the shared
// `useMetricHistory` accumulation into a uPlot AlignedData buffer. No JSX, no
// hooks — kept separate from ScopePanel so the alignment/forward-fill logic is
// unit-testable without rendering a chart.

import type { MetricSample } from '../../graph/useMetricHistory';
import type { ScopeMetric } from '../../../store/uiStore';

function selectMetric(s: MetricSample, metric: ScopeMetric): number | null {
  switch (metric) {
    case 'hz':
      return s.hz;
    case 'shortfall':
      return s.shortfall;
    case 'jitter':
      return s.jitterP95;
  }
}

/**
 * Builds uPlot AlignedData `[xs, ...ysPerTopic]` for one Health panel.
 *
 * The per-topic sample streams are NOT time-aligned (each topic's SSE sample
 * lands on its own schedule), so this aligns them onto the union of every
 * in-window timestamp (sorted, deduped) and forward-fills each topic's latest
 * value at each union point (null before that topic's first in-window sample).
 *
 * x is in SECONDS (uPlot `time: true` expects unix seconds; MetricSample.t is
 * wall-clock ms).
 */
export function healthAlignedData(
  history: Map<string, MetricSample[]>,
  topics: string[],
  metric: ScopeMetric,
  windowSec: number,
  nowMs: number,
): (number | null)[][] {
  const cutoff = nowMs - windowSec * 1000;
  const perTopic = topics.map((t) => (history.get(t) ?? []).filter((s) => s.t >= cutoff));

  const tsSet = new Set<number>();
  for (const arr of perTopic) for (const s of arr) tsSet.add(s.t);
  const xs = [...tsSet].sort((a, b) => a - b);

  const ys: (number | null)[][] = perTopic.map((arr) => {
    let idx = 0;
    let last: number | null = null;
    const col: (number | null)[] = [];
    for (const t of xs) {
      while (idx < arr.length && arr[idx]!.t <= t) {
        last = selectMetric(arr[idx]!, metric);
        idx++;
      }
      col.push(last);
    }
    return col;
  });

  return [xs.map((t) => t / 1000), ...ys];
}

/** The most recent non-null `expected_hz` reported for a topic, or null if it
 *  never reported one (used for the single-topic Frequency reference line). */
export function latestExpected(
  history: Map<string, MetricSample[]>,
  topic: string,
): number | null {
  const arr = history.get(topic) ?? [];
  for (let i = arr.length - 1; i >= 0; i--) {
    const v = arr[i]!.expected;
    if (v != null) return v;
  }
  return null;
}
