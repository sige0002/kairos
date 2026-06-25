// Graph tab: time-series topic health. The backend streams point-in-time
// snapshots over SSE (`metrics`); we accumulate a rolling client-side history
// per topic and draw four 2x2 line charts — rate achievement %, latency ms,
// bandwidth MB/s, loss %. Pause freezes accumulation; the window picker trims
// how much history is shown.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../../api/queryKeys';
import type { MetricsSnapshot } from '../../api/types';
import type { RuntimeConfig } from '../../config';
import { Card, SectionLabel, cn } from '../../components/ui';
import { matchesTopic } from '../record/topics';

// Distinct line colours; assigned to topics by first-seen order.
const PALETTE = ['#0d9488', '#0891b2', '#d97706', '#fb7185', '#16a34a', '#7c3aed'];
const DEFAULT_COLOR = '#0d9488';

function paletteColor(i: number): string {
  return PALETTE[i % PALETTE.length] ?? DEFAULT_COLOR;
}

const WINDOWS: { id: string; label: string; ms: number }[] = [
  { id: '30s', label: '30s', ms: 30_000 },
  { id: '1m', label: '1m', ms: 60_000 },
  { id: '5m', label: '5m', ms: 300_000 },
];

interface Point {
  t: number;
  rate: number | null; // % of expected hz
  lat: number | null; // ms
  bw: number | null; // MB/s
  loss: number | null; // %
}

type History = Map<string, Point[]>;

const MAX_POINTS = 600; // hard cap per topic (5m @ ~1-2Hz)

interface MetricSpec {
  key: 'rate' | 'lat' | 'bw' | 'loss';
  title: string;
  unit: string;
  // A sensible fixed ceiling; charts also auto-grow to fit the data.
  floorMax: number;
}

const METRICS: MetricSpec[] = [
  { key: 'rate', title: 'レート達成率', unit: '%', floorMax: 100 },
  { key: 'lat', title: '遅延', unit: 'ms', floorMax: 50 },
  { key: 'bw', title: '帯域', unit: 'MB/s', floorMax: 1 },
  { key: 'loss', title: 'ロス率', unit: '%', floorMax: 1 },
];

function shortName(topic: string): string {
  const parts = topic.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? topic;
}

function Chart({
  spec,
  series,
  windowMs,
  nowRef,
}: {
  spec: MetricSpec;
  series: { name: string; color: string; points: Point[] }[];
  windowMs: number;
  nowRef: number;
}) {
  const W = 600;
  const H = 170;
  const valueOf = (p: Point) => p[spec.key];
  const t0 = nowRef - windowMs;

  // Only points inside the selected window are scaled, drawn and summed into the
  // y-axis max — otherwise older points clamp onto x=0 and inflate the scale.
  const windowed = series.map((s) => ({
    ...s,
    points: s.points.filter((p) => p.t >= t0),
  }));

  const max = Math.max(
    spec.floorMax,
    ...windowed.flatMap((s) => s.points.map((p) => valueOf(p) ?? 0)),
  );

  const toXY = (p: Point): [number, number] | null => {
    const v = valueOf(p);
    if (v === null || v === undefined) return null;
    const x = ((p.t - t0) / windowMs) * W;
    const y = H - (v / max) * (H - 10) - 5;
    return [Math.max(0, Math.min(W, x)), y];
  };

  return (
    <Card className="p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-[13px] font-semibold text-gray-700">{spec.title}</span>
        <span className="font-mono text-[11px] text-gray-400">{spec.unit}</span>
      </div>
      <div className="mb-2.5 flex flex-wrap gap-x-3 gap-y-1">
        {windowed.map((s) => {
          const last = [...s.points].reverse().find((p) => valueOf(p) !== null);
          const v = last ? valueOf(last) : null;
          return (
            <span key={s.name} className="flex items-center gap-1.5">
              <span
                className="inline-block h-[3px] w-3 rounded-sm"
                style={{ background: s.color }}
              />
              <span className="font-mono text-[10.5px] text-gray-500">{s.name}</span>
              <span className="font-mono text-[10.5px] font-semibold text-gray-700">
                {v === null || v === undefined ? '—' : v.toFixed(spec.key === 'bw' ? 2 : 0)}
              </span>
            </span>
          );
        })}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none">
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1={0}
            x2={W}
            y1={H * f}
            y2={H * f}
            stroke="#f1f3f5"
            strokeWidth={1}
          />
        ))}
        {windowed.map((s) => {
          const pts = s.points
            .map(toXY)
            .filter((xy): xy is [number, number] => xy !== null)
            .map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`)
            .join(' ');
          if (!pts) return null;
          return (
            <polyline
              key={s.name}
              points={pts}
              fill="none"
              stroke={s.color}
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          );
        })}
      </svg>
    </Card>
  );
}

export function GraphTab({ config }: { config: RuntimeConfig }) {
  const [windowId, setWindowId] = useState('1m');
  const [paused, setPaused] = useState(false);
  const windowMs = WINDOWS.find((w) => w.id === windowId)?.ms ?? 60_000;

  const expectedHzPatterns = useMemo(
    () => Object.entries(config.defaults.expected_hz ?? {}),
    [config],
  );
  const expectedHz = useMemo(
    () =>
      (name: string): number | undefined => {
        const hit = expectedHzPatterns.find(([pat]) => matchesTopic(pat, name));
        return hit ? hit[1] : undefined;
      },
    [expectedHzPatterns],
  );

  // SSE-fed metrics snapshot (written by useEventStream).
  const sseOnly = () => {
    throw new Error('SSE-only cache: written by useEventStream');
  };
  const metricsQuery = useQuery<MetricsSnapshot>({
    queryKey: queryKeys.metrics,
    queryFn: sseOnly,
    enabled: false,
  });

  const historyRef = useRef<History>(new Map());
  const colorRef = useRef<Map<string, string>>(new Map());
  // Guard against appending the same snapshot twice (StrictMode double-invoke,
  // or a re-render that doesn't carry a fresh snapshot).
  const lastSeenRef = useRef<number>(0);
  const [, setTick] = useState(0);

  // Append a new sample per topic whenever a fresh snapshot arrives.
  const updatedAt = metricsQuery.dataUpdatedAt;
  useEffect(() => {
    if (paused) return;
    const snap = metricsQuery.data;
    if (!snap || updatedAt === lastSeenRef.current) return;
    lastSeenRef.current = updatedAt;
    const now = Date.now();
    const hist = historyRef.current;
    for (const m of snap.topics) {
      const exp = expectedHz(m.name);
      const point: Point = {
        t: now,
        rate: m.hz != null && exp ? (m.hz / exp) * 100 : null,
        lat: m.stamp_delay_ms ?? null,
        bw: m.bandwidth_bps != null ? m.bandwidth_bps / 1e6 : null,
        loss: m.loss_rate != null ? m.loss_rate * 100 : null,
      };
      const arr = hist.get(m.name) ?? [];
      arr.push(point);
      // Trim to the longest window + cap.
      const cutoff = now - 300_000;
      let head = arr[0];
      while (head && (head.t < cutoff || arr.length > MAX_POINTS)) {
        arr.shift();
        head = arr[0];
      }
      hist.set(m.name, arr);
      if (!colorRef.current.has(m.name)) {
        colorRef.current.set(m.name, paletteColor(colorRef.current.size));
      }
    }
    setTick((n) => n + 1);
  }, [updatedAt, paused, metricsQuery.data, expectedHz]);

  const now = Date.now();
  // Plot the topics we have history for, most-recently-active first, capped.
  const series = useMemo(() => {
    const entries = [...historyRef.current.entries()]
      .filter(([, pts]) => pts.length > 0)
      .sort((a, b) => (b[1].at(-1)?.t ?? 0) - (a[1].at(-1)?.t ?? 0))
      .slice(0, PALETTE.length);
    return entries.map(([name, points]) => ({
      name: shortName(name),
      color: colorRef.current.get(name) ?? DEFAULT_COLOR,
      points,
    }));
  }, [updatedAt, windowId, paused]);

  const empty = series.length === 0;

  return (
    <div className="flex flex-col gap-[18px]">
      <div className="flex flex-wrap items-center gap-3">
        <SectionLabel>Graph</SectionLabel>
        <span className="font-mono text-[11.5px] text-gray-400">
          {series.length} topics · {windowId} window
        </span>
        <div className="flex-1" />
        <div className="flex gap-[3px] rounded-control border border-gray-200 bg-gray-100 p-1">
          {WINDOWS.map((w) => (
            <button
              key={w.id}
              type="button"
              onClick={() => setWindowId(w.id)}
              className={cn(
                'rounded-chip px-3 py-1 text-xs font-medium transition-colors',
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
          onClick={() => setPaused((p) => !p)}
          className={cn(
            'rounded-control border px-3 py-1.5 text-xs font-medium transition-colors',
            paused
              ? 'border-amber-200 bg-amber-50 text-amber-700'
              : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50',
          )}
        >
          {paused ? '再開' : '一時停止'}
        </button>
      </div>

      {empty ? (
        <Card className="p-8 text-center text-sm text-gray-500">
          メトリクスの受信を待っています。トピックが流れ始めるとライブのチャートが描画されます。
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-[18px] md:grid-cols-2">
          {METRICS.map((spec) => (
            <Chart
              key={spec.key}
              spec={spec}
              series={series}
              windowMs={windowMs}
              nowRef={now}
            />
          ))}
        </div>
      )}
    </div>
  );
}
