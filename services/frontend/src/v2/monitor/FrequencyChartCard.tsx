// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// One chart PANEL for the Monitor Topics view: the panel's selected topics'
// chosen metric over time, OVERLAID as distinct series on the shared uPlot
// infrastructure (src/features/probe/UplotChart.tsx — NEVER rewritten; its
// empty-buffer redraw guard took a day to debug). Full v1 Graph-tab parity in the
// v2 skin: a per-panel metric selector (Frequency / Bandwidth / Max gap / Rate vs
// expected), REAL REC/STOP markers, and expected_hz / 100%-target ref lines.
//
// Panels are add/removable (v1 Graph tab). The PRIMARY panel's topic set is driven
// by the TopicsTable row clicks below (unchanged UX for the common case); every
// other panel carries its own compact add-topic control + removable series chips.
// The window (30s/1m/5m) and Pause are GLOBAL across panels, so they live in the
// TopicsView toolbar — this card only receives the shared history / clock / markers
// (accumulated once by the parent) plus its own metric + topics.

import { useMemo } from 'react';
import { formatBaseline, type MonitorRow } from '../../features/monitor/useMonitorRows';
import { DEFAULT_WARN_SHORTFALL_PCT } from '../../features/monitor/thresholds';
import type { MetricSample } from '../../features/graph/useMetricHistory';
import {
  UplotChart,
  type UplotSeriesConf,
  type RefLine,
  type ChartMarker,
} from '../../features/probe/UplotChart';
import { Card } from '../../components/ui';
import { amber } from '../tokens';
import {
  MONITOR_METRICS,
  MAX_SERIES,
  type MonitorMetricKey,
  type MonitorWindowId,
  alignMetricSeries,
  buildLabelMap,
  hasAnyValue,
  metricDef,
  paletteColor,
  shortName,
  windowMs,
} from './chartSeries';
import type { ChartPanel } from './panelStore';
import { useMeasuredHeight } from './useMeasuredHeight';

/** Last non-null value in an aligned column (the series' current reading). */
function lastValue(col: (number | null)[]): number | null {
  for (let i = col.length - 1; i >= 0; i--) {
    if (col[i] != null) return col[i]!;
  }
  return null;
}

/** y-axis tuning for every Monitor chart (I-10): a wider gutter plus a tick
 *  formatter that caps precision at 3 decimals (trailing zeros trimmed) so a
 *  tight range like 29.975 renders in full instead of clipping its leading
 *  digit. A module constant so its identity is stable across renders. */
const CHART_Y_AXIS = {
  size: 56,
  format: (v: number) => String(Number(v.toFixed(3))),
};

export function FrequencyChartCard({
  panel,
  isPrimary,
  rows,
  topics,
  windowId,
  history,
  updatedAt,
  now,
  markers,
  chartHeight,
  layoutKey,
  removable,
  onMetricChange,
  onToggleTopic,
  onRemove,
}: {
  panel: ChartPanel;
  /** The primary panel (index 0) — its topic set is driven by the TopicsTable, so
   *  it shows a read-only legend rather than its own add-topic control. */
  isPrimary: boolean;
  rows: MonitorRow[];
  /** Resolved charted topics for THIS panel (already filtered + capped). */
  topics: string[];
  /** Global time window (shared across panels — lives in the TopicsView toolbar). */
  windowId: MonitorWindowId;
  /** Shared rolling accumulator (one instance for all panels). */
  history: Map<string, MetricSample[]>;
  /** Accumulation tick — a memo dependency since `history` mutates in place. */
  updatedAt: number;
  /** Shared window-anchor clock (frozen by the global Pause). */
  now: number;
  /** Shared REC/STOP markers from /record/status. */
  markers: ChartMarker[];
  /** Per-panel-count chart height (shrinks as panels are added — no page scroll). */
  chartHeight: number;
  /** Remounts uPlot when the grid geometry changes so its fixed-px canvas picks
   *  up the new column width (uPlot only self-resizes on a window resize). */
  layoutKey: string;
  removable: boolean;
  onMetricChange: (m: MonitorMetricKey) => void;
  onToggleTopic: (name: string) => void;
  onRemove: () => void;
}) {
  const metric = metricDef(panel.metric);
  const ms = windowMs(windowId);
  const sfx = isPrimary ? '' : `-${panel.id}`;

  // Track the actual plot-area slot so the uPlot canvas fills it exactly rather
  // than being clipped by a shorter overflow-hidden ancestor (I-4). Falls back to
  // the parent's fixed chartHeight before the first measure / in a test env.
  const [plotAreaRef, measuredHeight] = useMeasuredHeight<HTMLDivElement>();

  const labelMap = useMemo(() => buildLabelMap(topics), [topics]);
  const labelFor = (t: string) => labelMap.get(t) ?? shortName(t);
  const rowFor = (t: string): MonitorRow | null => rows.find((r) => r.name === t) ?? null;
  const availableTopics = useMemo(() => rows.map((r) => r.name), [rows]);

  // x axis = sorted union of every selected topic's in-window sample times; each
  // column null-filled at ticks the topic has no sample for (see alignMetricSeries).
  const { xs, cols } = useMemo(
    () => alignMetricSeries(topics, history, metric.select, { ms, nowMs: now }),
    // history mutates in place; `updatedAt` is its accumulation tick.
    [history, topics, metric, ms, now, updatedAt],
  );
  const data = useMemo<(number | null)[][]>(() => [xs, ...cols], [xs, cols]);
  const hasData = hasAnyValue(cols);

  const series: UplotSeriesConf[] = useMemo(
    () => topics.map((t, i) => ({ label: labelMap.get(t) ?? shortName(t), stroke: paletteColor(i) })),
    [topics, labelMap],
  );

  // Reference line: expected_hz for a single Hz-charted topic (unambiguous only
  // for one topic — several expectations would clutter one axis); the 100% target
  // for the rate metric (shared across topics). Nothing for bandwidth / gap.
  const single = topics.length === 1 ? topics[0]! : null;
  const singleExpected = single ? (rowFor(single)?.expected_hz ?? null) : null;
  const refLines: RefLine[] | undefined =
    metric.key === 'hz' && single && singleExpected != null
      ? [{ v: singleExpected, color: amber[600] }]
      : metric.key === 'rate'
        ? [{ v: 100, color: amber[600] }]
        : undefined;

  // Footer references the PRIMARY (first-selected) topic of THIS panel.
  const primaryTopic = topics[0] ?? null;
  const primaryRow = primaryTopic ? rowFor(primaryTopic) : null;
  const primaryLast = cols[0] ? lastValue(cols[0]) : null;
  const current = primaryLast != null ? `${primaryLast.toFixed(metric.digits)} ${metric.unit}` : '—';
  const primaryExpected = primaryRow?.expected_hz ?? null;
  const expectedText =
    primaryExpected != null
      ? `${primaryExpected} Hz`
      : (primaryRow ? formatBaseline(primaryRow) : null) ?? '—';
  const warnBelow =
    primaryExpected != null
      ? `${(primaryExpected * (1 - DEFAULT_WARN_SHORTFALL_PCT / 100)).toFixed(1)} Hz`
      : '—';

  const title =
    topics.length === 0
      ? 'No topic selected'
      : topics.length === 1
        ? topics[0]!
        : `${topics.length} topics`;

  // Non-primary add-topic control: currently-flowing topics not already charted,
  // hidden once the panel hits the MAX_SERIES overlay cap.
  const addable = availableTopics.filter((t) => !topics.includes(t));
  const atCap = topics.length >= MAX_SERIES;

  return (
    <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-gray-100 px-[18px] py-3">
        <span className="truncate font-mono text-[13px] font-semibold text-gray-900">{title}</span>
        <select
          data-testid={`freq-metric-select${sfx}`}
          aria-label="chart metric"
          value={panel.metric}
          onChange={(e) => onMetricChange(e.target.value as MonitorMetricKey)}
          className="rounded-control border border-gray-200 px-2 py-1 text-[12px] font-medium text-gray-700 focus:border-teal-600 focus:outline-none"
        >
          {MONITOR_METRICS.map((m) => (
            <option key={m.key} value={m.key}>
              {m.label} ({m.unit})
              {m.key === 'rate' ? ' · needs expected_hz' : ''}
            </option>
          ))}
        </select>
        <div className="flex-1" />
        {removable && (
          <button
            type="button"
            data-testid={`freq-remove${sfx}`}
            aria-label="remove chart"
            onClick={onRemove}
            className="rounded-control border border-red-200 px-2.5 py-1 text-[11px] font-semibold text-red-700 hover:bg-red-50"
          >
            Remove
          </button>
        )}
      </div>

      {isPrimary ? (
        // Primary panel: read-only legend (the TopicsTable row clicks drive its set).
        <div
          data-testid={`freq-chart-legend${sfx}`}
          className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-gray-100 px-[18px] py-2"
        >
          {topics.length === 0 ? (
            <span className="text-[11.5px] text-gray-500">No series selected.</span>
          ) : (
            topics.map((t, i) => {
              const v = cols[i] ? lastValue(cols[i]!) : null;
              const shown = v != null ? `${v.toFixed(metric.digits)} ${metric.unit}` : '—';
              return (
                <span
                  key={t}
                  data-testid={`freq-legend${sfx}-${t}`}
                  className="inline-flex items-center gap-1.5 text-[11.5px] text-gray-500"
                >
                  <span className="h-[3px] w-3.5 rounded-sm" style={{ background: paletteColor(i) }} />
                  <span className="font-mono">{labelFor(t)}</span>
                  <span className="font-semibold text-gray-700">{shown}</span>
                </span>
              );
            })
          )}
          {refLines && (
            <span className="inline-flex items-center gap-1.5 text-[11.5px] text-gray-500">
              <span
                className="h-0 w-3.5 border-t-2"
                style={{ borderTopStyle: 'dashed', borderTopColor: amber[600] }}
              />
              {metric.key === 'rate' ? '100% target' : `expected ${singleExpected} Hz`}
            </span>
          )}
        </div>
      ) : (
        // Non-primary panel: its own removable series chips + an add-topic picker.
        <div
          data-testid={`freq-chart-legend${sfx}`}
          className="flex flex-wrap items-center gap-1.5 border-b border-gray-100 px-[18px] py-2"
        >
          {topics.map((t, i) => {
            const v = cols[i] ? lastValue(cols[i]!) : null;
            const shown = v != null ? `${v.toFixed(metric.digits)} ${metric.unit}` : '—';
            return (
              <span
                key={t}
                data-testid={`freq-legend${sfx}-${t}`}
                className="inline-flex items-center gap-1.5 rounded-chip border border-gray-200 bg-white py-0.5 pl-2 pr-1 text-[11px] text-gray-500"
              >
                <span className="h-[3px] w-3.5 rounded-sm" style={{ background: paletteColor(i) }} />
                <span className="font-mono">{labelFor(t)}</span>
                <span className="font-semibold text-gray-700">{shown}</span>
                <button
                  type="button"
                  data-testid={`freq-chip-remove${sfx}-${t}`}
                  aria-label={`remove ${t} from chart`}
                  onClick={() => onToggleTopic(t)}
                  className="ml-0.5 rounded-sm px-1 text-gray-500 hover:bg-gray-100 hover:text-gray-700"
                >
                  ×
                </button>
              </span>
            );
          })}
          {atCap ? (
            <span className="text-[10.5px] text-amber-700">
              {MAX_SERIES}/{MAX_SERIES} series
            </span>
          ) : (
            <select
              data-testid={`freq-add-topic${sfx}`}
              aria-label="add topic to chart"
              value=""
              onChange={(e) => {
                if (e.target.value) onToggleTopic(e.target.value);
              }}
              disabled={addable.length === 0}
              className="rounded-control border border-gray-200 px-2 py-0.5 text-[11px] font-medium text-gray-600 focus:border-teal-600 focus:outline-none disabled:text-gray-300"
            >
              <option value="">{addable.length === 0 ? 'No more topics' : '+ Add topic'}</option>
              {addable.map((t) => (
                <option key={t} value={t}>
                  {labelFor(t)}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      <div
        ref={plotAreaRef}
        className="min-h-0 flex-1 overflow-hidden px-[18px] py-2.5"
      >
        {topics.length > 0 && hasData ? (
          // uPlot's own bottom legend ("Time: -- observed: --") duplicates the
          // header legend above and isn't in the mock — scoped away by the
          // .monitor-freq-chart rule injected once in TopicsView (not in
          // UplotChart, which is shared and never rewritten; see its header).
          <div className="monitor-freq-chart h-full">
            <UplotChart
              key={layoutKey}
              data={data}
              series={series}
              refLines={refLines}
              markers={markers}
              height={measuredHeight || chartHeight}
              yAxis={CHART_Y_AXIS}
            />
          </div>
        ) : (
          <p
            data-testid={`freq-chart-empty${sfx}`}
            className="flex h-full items-center justify-center text-center text-[12px] text-gray-500"
          >
            {topics.length === 0
              ? isPrimary
                ? 'No topic to chart yet — pick one from the table below once topics are discovered.'
                : 'No topic to chart — use "+ Add topic" above.'
              : (metric.note ??
                `No ${metric.label.toLowerCase()} data yet — history builds from when you opened Monitor.`)}
          </p>
        )}
      </div>

      <div className="flex flex-wrap gap-4 border-t border-gray-100 px-[18px] py-2.5 text-xs text-gray-500">
        {topics.length > 1 && primaryTopic && (
          <span>
            primary{' '}
            <span className="font-mono font-semibold text-gray-900">{labelFor(primaryTopic)}</span>
          </span>
        )}
        <span>
          current <span className="font-mono font-semibold text-amber-700">{current}</span>
        </span>
        {metric.hzLike && (
          <>
            <span>
              expected <span className="font-mono font-semibold text-gray-900">{expectedText}</span>
            </span>
            <span>
              warn below <span className="font-mono font-semibold text-gray-900">{warnBelow}</span>
            </span>
          </>
        )}
        <div className="flex-1" />
        <span className="text-gray-500">
          REC markers are real · observed shortfall — no confirmed loss
        </span>
      </div>
    </Card>
  );
}
