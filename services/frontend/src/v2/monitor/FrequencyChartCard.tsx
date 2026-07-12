// Frequency chart card: the selected topic's observed Hz over time, on the
// shared uPlot infrastructure (src/features/probe/UplotChart.tsx — NEVER
// rewritten; its empty-buffer redraw guard took a day to debug). Fed by
// useMetricHistory, the same rolling client-side accumulator the old Graph tab
// used. The mock's red REC markers, amber warn band and "rate drop" annotation
// need an event model that doesn't exist yet (Phase 2) — omitted here, noted
// in the footer instead of faked.

import { useMemo } from 'react';
import type { RuntimeConfig } from '../../config';
import { formatBaseline, type MonitorRow } from '../../features/monitor/useMonitorRows';
import { DEFAULT_WARN_SHORTFALL_PCT } from '../../features/monitor/thresholds';
import { useMetricHistory } from '../../features/graph/useMetricHistory';
import { UplotChart, type UplotSeriesConf, type RefLine } from '../../features/probe/UplotChart';
import { Card } from '../../components/ui';
import { teal, amber } from '../tokens';

const SERIES: UplotSeriesConf[] = [{ label: 'observed', stroke: teal[600] }];

export function FrequencyChartCard({
  config,
  rows,
  topic,
}: {
  config: RuntimeConfig;
  rows: MonitorRow[];
  topic: string | null;
}) {
  // `history` is a stable Map reference mutated in place (see useMetricHistory),
  // so `updatedAt` (its monotone accumulation tick) has to be the recompute
  // trigger — keying off `history` itself never changes identity and would
  // freeze `data` at whatever was in the map on the first render.
  const { history, updatedAt } = useMetricHistory(config, false);
  const row: MonitorRow | null = rows.find((r) => r.name === topic) ?? null;

  const data = useMemo<(number | null)[][]>(() => {
    if (!topic) return [[]];
    const samples = history.get(topic) ?? [];
    return [samples.map((s) => s.t / 1000), samples.map((s) => s.hz)];
  }, [history, topic, updatedAt]);

  const expectedHz = row?.expected_hz ?? null;
  const refLines: RefLine[] | undefined =
    expectedHz != null ? [{ v: expectedHz, color: amber[600] }] : undefined;

  const current = row?.hz != null ? `${row.hz.toFixed(1)} Hz` : '—';
  const expectedText =
    expectedHz != null ? `${expectedHz} Hz` : (row ? formatBaseline(row) : null) ?? '—';
  const warnBelow =
    expectedHz != null
      ? `${(expectedHz * (1 - DEFAULT_WARN_SHORTFALL_PCT / 100)).toFixed(1)} Hz`
      : '—';

  return (
    <Card className="flex flex-1 flex-col lg:min-h-0">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-gray-100 px-[18px] py-3">
        <span className="font-mono text-[13px] font-semibold text-gray-900">
          {topic ?? 'No topic selected'}
        </span>
        <span className="text-xs text-gray-500">frequency (Hz)</span>
        <div className="flex-1" />
        <span className="inline-flex items-center gap-1.5 text-[11.5px] text-gray-500">
          <span className="h-[3px] w-3.5 rounded-sm" style={{ background: teal[600] }} />
          observed
        </span>
        <span className="inline-flex items-center gap-1.5 text-[11.5px] text-gray-500">
          <span
            className="h-0 w-3.5 border-t-2"
            style={{ borderTopStyle: 'dashed', borderTopColor: amber[600] }}
          />
          expected {expectedHz != null ? `${expectedHz} Hz` : '—'}
        </span>
      </div>
      <div className="min-h-0 flex-1 px-[18px] py-2.5">
        {topic ? (
          <UplotChart data={data} series={SERIES} refLines={refLines} height={240} />
        ) : (
          <p className="flex h-full items-center justify-center text-center text-[12px] text-gray-400">
            No topic to chart yet — pick one from the table below once topics are discovered.
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-4 border-t border-gray-100 px-[18px] py-2.5 text-xs text-gray-500">
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
          observed shortfall — no confirmed loss · REC markers &amp; warn band pending an event
          model (Phase 2)
        </span>
      </div>
    </Card>
  );
}
