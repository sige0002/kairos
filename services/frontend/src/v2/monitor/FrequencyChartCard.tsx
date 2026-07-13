// Frequency chart card: the selected topics' chosen metric over time, OVERLAID
// as distinct series on the shared uPlot infrastructure (src/features/probe/
// UplotChart.tsx — NEVER rewritten; its empty-buffer redraw guard took a day to
// debug). Full v1 Graph-tab parity in the v2 skin: a metric selector (Frequency /
// Bandwidth / Max gap / Rate vs expected), a 30s/1m/5m window, Pause/Resume, and
// REAL REC/STOP markers derived from /record/status (useRecMarkers → uiStore).
// Fed by useMetricHistory, the same rolling client-side accumulator the old Graph
// tab used. The mock's amber warn BAND still needs a per-topic event model that
// doesn't exist yet (Phase 2) — noted in the footer, not faked.

import { useMemo, useState } from 'react';
import type { RuntimeConfig } from '../../config';
import { formatBaseline, type MonitorRow } from '../../features/monitor/useMonitorRows';
import { DEFAULT_WARN_SHORTFALL_PCT } from '../../features/monitor/thresholds';
import { useMetricHistory } from '../../features/graph/useMetricHistory';
import { UplotChart, type UplotSeriesConf, type RefLine } from '../../features/probe/UplotChart';
import { Card, cn } from '../../components/ui';
import { amber } from '../tokens';
import { useNowClock } from './useNowClock';
import { useRecMarkers } from './useRecMarkers';
import {
  MONITOR_METRICS,
  MONITOR_WINDOWS,
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

/** Last non-null value in an aligned column (the series' current reading). */
function lastValue(col: (number | null)[]): number | null {
  for (let i = col.length - 1; i >= 0; i--) {
    if (col[i] != null) return col[i]!;
  }
  return null;
}

export function FrequencyChartCard({
  config,
  rows,
  topics,
}: {
  config: RuntimeConfig;
  rows: MonitorRow[];
  topics: string[];
}) {
  const [metricKey, setMetricKey] = useState<MonitorMetricKey>('hz');
  const [windowId, setWindowId] = useState<MonitorWindowId>('1m');
  const [paused, setPaused] = useState(false);
  const metric = metricDef(metricKey);
  const ms = windowMs(windowId);

  // Pause freezes both the accumulation (v1 useMetricHistory frozen flag) AND the
  // window anchor, so the visible chart truly stops rather than scrolling the
  // frozen points off-screen. Resume restarts both.
  const now = useNowClock(!paused);
  const { history, updatedAt } = useMetricHistory(config, paused);
  const markers = useRecMarkers();

  const labelMap = useMemo(() => buildLabelMap(topics), [topics]);
  const labelFor = (t: string) => labelMap.get(t) ?? shortName(t);
  const rowFor = (t: string): MonitorRow | null => rows.find((r) => r.name === t) ?? null;

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

  // Footer references the PRIMARY (first-selected) topic.
  const primary = topics[0] ?? null;
  const primaryRow = primary ? rowFor(primary) : null;
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

  return (
    <Card className="flex flex-1 flex-col lg:min-h-0">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-gray-100 px-[18px] py-3">
        <span className="font-mono text-[13px] font-semibold text-gray-900">{title}</span>
        <select
          data-testid="freq-metric-select"
          aria-label="chart metric"
          value={metricKey}
          onChange={(e) => setMetricKey(e.target.value as MonitorMetricKey)}
          className="rounded-control border border-gray-200 px-2 py-1 text-[12px] font-medium text-gray-700 focus:border-teal-500 focus:outline-none"
        >
          {MONITOR_METRICS.map((m) => (
            <option key={m.key} value={m.key}>
              {m.label} ({m.unit})
              {m.key === 'rate' ? ' · needs expected_hz' : ''}
            </option>
          ))}
        </select>
        <div className="flex-1" />
        <div className="flex gap-[3px] rounded-control border border-gray-200 bg-gray-100 p-1">
          {MONITOR_WINDOWS.map((w) => (
            <button
              key={w.id}
              type="button"
              data-testid={`freq-window-${w.id}`}
              aria-pressed={w.id === windowId}
              onClick={() => setWindowId(w.id)}
              className={cn(
                'rounded-chip px-2.5 py-0.5 text-[11px] font-medium transition-colors',
                w.id === windowId
                  ? 'bg-white text-teal-700 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700',
              )}
            >
              {w.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          data-testid="freq-pause"
          aria-pressed={paused}
          onClick={() => setPaused((p) => !p)}
          className={cn(
            'rounded-control border px-3 py-1 text-[11px] font-medium transition-colors',
            paused
              ? 'border-amber-200 bg-amber-50 text-amber-700'
              : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50',
          )}
        >
          {paused ? 'Resume' : 'Pause'}
        </button>
      </div>

      <div
        data-testid="freq-chart-legend"
        className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-gray-100 px-[18px] py-2"
      >
        {topics.length === 0 ? (
          <span className="text-[11.5px] text-gray-400">No series selected.</span>
        ) : (
          topics.map((t, i) => {
            const v = cols[i] ? lastValue(cols[i]!) : null;
            const shown = v != null ? `${v.toFixed(metric.digits)} ${metric.unit}` : '—';
            return (
              <span
                key={t}
                data-testid={`freq-legend-${t}`}
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

      <div className="min-h-0 flex-1 px-[18px] py-2.5">
        {topics.length > 0 && hasData ? (
          // uPlot's own bottom legend ("Time: -- observed: --") duplicates the
          // custom header legend above and isn't in the mock — scoped away here
          // (not in UplotChart itself, which is shared and never rewritten; see
          // the file header) rather than passed as a construction option, since
          // UplotChart's props don't expose raw uPlot options.
          <div className="monitor-freq-chart">
            <style>{'.monitor-freq-chart .u-legend { display: none; }'}</style>
            <UplotChart data={data} series={series} refLines={refLines} markers={markers} height={240} />
          </div>
        ) : (
          <p
            data-testid="freq-chart-empty"
            className="flex h-full items-center justify-center text-center text-[12px] text-gray-400"
          >
            {topics.length === 0
              ? 'No topic to chart yet — pick one from the table below once topics are discovered.'
              : (metric.note ?? `No ${metric.label.toLowerCase()} data in the last ${windowId}.`)}
          </p>
        )}
      </div>

      <div className="flex flex-wrap gap-4 border-t border-gray-100 px-[18px] py-2.5 text-xs text-gray-500">
        {topics.length > 1 && primary && (
          <span>
            primary <span className="font-mono font-semibold text-gray-900">{labelFor(primary)}</span>
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
        <span className="text-gray-400">
          REC markers are real · observed shortfall, not confirmed loss · warn band pending an event model (Phase 2)
        </span>
      </div>
    </Card>
  );
}
