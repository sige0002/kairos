// Frequency chart card: the selected topics' observed Hz over time, OVERLAID as
// distinct series on the shared uPlot infrastructure (src/features/probe/
// UplotChart.tsx — NEVER rewritten; its empty-buffer redraw guard took a day to
// debug). This restores the v1 Graph tab's multi-topic overlay the v2 Monitor
// had dropped. Fed by useMetricHistory, the same rolling client-side accumulator
// the old Graph tab used. The mock's red REC markers, amber warn band and "rate
// drop" annotation need an event model that doesn't exist yet (Phase 2) — omitted
// here, noted in the footer instead of faked.

import { useMemo } from 'react';
import type { RuntimeConfig } from '../../config';
import { formatBaseline, type MonitorRow } from '../../features/monitor/useMonitorRows';
import { DEFAULT_WARN_SHORTFALL_PCT } from '../../features/monitor/thresholds';
import { useMetricHistory } from '../../features/graph/useMetricHistory';
import { UplotChart, type UplotSeriesConf, type RefLine } from '../../features/probe/UplotChart';
import { Card } from '../../components/ui';
import { amber } from '../tokens';
import { alignHzSeries, buildLabelMap, paletteColor, shortName } from './chartSeries';

export function FrequencyChartCard({
  config,
  rows,
  topics,
}: {
  config: RuntimeConfig;
  rows: MonitorRow[];
  topics: string[];
}) {
  // `history` is a stable Map reference mutated in place (see useMetricHistory),
  // so `updatedAt` (its monotone accumulation tick) has to be the recompute
  // trigger — keying off `history` itself never changes identity and would
  // freeze `data` at whatever was in the map on the first render.
  const { history, updatedAt } = useMetricHistory(config, false);

  const labelMap = useMemo(() => buildLabelMap(topics), [topics]);
  const labelFor = (t: string) => labelMap.get(t) ?? shortName(t);
  const rowFor = (t: string): MonitorRow | null => rows.find((r) => r.name === t) ?? null;

  // x axis = sorted union of every selected topic's sample times; each column is
  // null-filled at ticks the topic has no sample for (see alignHzSeries).
  const data = useMemo<(number | null)[][]>(() => {
    if (topics.length === 0) return [[]];
    const { xs, cols } = alignHzSeries(topics, history);
    return [xs, ...cols];
  }, [history, topics, updatedAt]);

  const series: UplotSeriesConf[] = useMemo(
    () => topics.map((t, i) => ({ label: labelMap.get(t) ?? shortName(t), stroke: paletteColor(i) })),
    [topics, labelMap],
  );

  // The amber expected-Hz reference line is unambiguous only for a single topic;
  // with 2+ overlaid, several expectations would clutter one axis, so it's
  // dropped and the footer says so.
  const single = topics.length === 1 ? topics[0]! : null;
  const singleRow = single ? rowFor(single) : null;
  const singleExpected = singleRow?.expected_hz ?? null;
  const refLines: RefLine[] | undefined =
    single && singleExpected != null ? [{ v: singleExpected, color: amber[600] }] : undefined;

  // Stat footer references the PRIMARY (first-selected) topic.
  const primary = topics[0] ?? null;
  const primaryRow = primary ? rowFor(primary) : null;
  const primaryExpected = primaryRow?.expected_hz ?? null;
  const current = primaryRow?.hz != null ? `${primaryRow.hz.toFixed(1)} Hz` : '—';
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
        <span className="text-xs text-gray-500">frequency (Hz)</span>
        <div className="flex-1" />
        <div data-testid="freq-chart-legend" className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {topics.map((t, i) => {
            const row = rowFor(t);
            const hz = row?.hz != null ? `${row.hz.toFixed(1)} Hz` : '—';
            return (
              <span
                key={t}
                data-testid={`freq-legend-${t}`}
                className="inline-flex items-center gap-1.5 text-[11.5px] text-gray-500"
              >
                <span className="h-[3px] w-3.5 rounded-sm" style={{ background: paletteColor(i) }} />
                <span className="font-mono">{labelFor(t)}</span>
                <span className="font-semibold text-gray-700">{hz}</span>
              </span>
            );
          })}
          {refLines && (
            <span className="inline-flex items-center gap-1.5 text-[11.5px] text-gray-500">
              <span
                className="h-0 w-3.5 border-t-2"
                style={{ borderTopStyle: 'dashed', borderTopColor: amber[600] }}
              />
              expected {singleExpected} Hz
            </span>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 px-[18px] py-2.5">
        {topics.length > 0 ? (
          // uPlot's own bottom legend ("Time: -- observed: --") duplicates the
          // custom header legend above and isn't in the mock — scoped away here
          // (not in UplotChart itself, which is shared and never rewritten; see
          // the file header) rather than passed as a construction option, since
          // UplotChart's props don't expose raw uPlot options.
          <div className="monitor-freq-chart">
            <style>{'.monitor-freq-chart .u-legend { display: none; }'}</style>
            <UplotChart data={data} series={series} refLines={refLines} height={240} />
          </div>
        ) : (
          <p className="flex h-full items-center justify-center text-center text-[12px] text-gray-400">
            No topic to chart yet — pick one from the table below once topics are discovered.
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
        <span>
          expected <span className="font-mono font-semibold text-gray-900">{expectedText}</span>
        </span>
        <span>
          warn below <span className="font-mono font-semibold text-gray-900">{warnBelow}</span>
        </span>
        <div className="flex-1" />
        <span className="text-gray-400">
          {topics.length > 1
            ? 'expected-Hz line shown when a single topic is charted · observed shortfall, no confirmed loss'
            : 'observed shortfall — no confirmed loss · REC markers & warn band pending an event model (Phase 2)'}
        </span>
      </div>
    </Card>
  );
}
