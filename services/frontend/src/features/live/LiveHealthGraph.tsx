// Live per-topic health graph (OL-③.2). The operator picks one topic in the
// Monitor panel and gets its health over time, right where the recording is
// driven — the "should I keep recording this?" view. Two stacked sparklines
// share an x-window: Frequency (actual Hz vs a dashed expected_hz reference) and
// "Shortfall vs expected" (rate_shortfall %, with dashed 2% / 5% status-threshold
// lines). REC / STOP markers show where recording started/stopped, so a dip can
// be read against the recording. All from the raw monitor — no payload decode.
//
// Deliberately titled "Shortfall vs expected", never "Loss": this is observed
// shortfall against the configured rate, not true message loss (see topic_monitor).

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge, Card, SectionLabel, StatusDot, cn } from '../../components/ui';
import { queryKeys } from '../../api/queryKeys';
import type { MetricsSnapshot } from '../../api/types';
import type { MetricSample } from '../graph/useMetricHistory';
import { statusTone } from '../monitor/useMonitorRows';
import { DEFAULT_WARN_SHORTFALL_PCT, DEFAULT_DANGER_SHORTFALL_PCT } from '../monitor/thresholds';

export interface RecMarker {
  t: number;
  kind: 'REC' | 'STOP';
}

const WINDOWS: { id: string; label: string; ms: number }[] = [
  { id: '30s', label: '30s', ms: 30_000 },
  { id: '1m', label: '1m', ms: 60_000 },
  { id: '5m', label: '5m', ms: 300_000 },
];

const W = 600;
const H = 120;

interface RefLine {
  v: number;
  color: string;
  label: string;
}

/** One sparkline: a metric line + optional dashed reference lines + REC/STOP marks. */
function Sparkline({
  title,
  unit,
  points,
  select,
  t0,
  windowMs,
  floorMax,
  digits,
  color,
  refs,
  markers,
  smooth,
}: {
  title: string;
  unit: string;
  points: MetricSample[];
  select: (s: MetricSample) => number | null;
  t0: number;
  windowMs: number;
  floorMax: number;
  digits: number;
  color: string;
  refs: RefLine[];
  markers: RecMarker[];
  // EWMA factor (0..1) for a de-jittered overlay line. The raw line stays (faint)
  // so the smoothing never hides a real value. Status is NOT driven off this.
  smooth?: number;
}) {
  const windowed = points.filter((p) => p.t >= t0);
  const values = windowed.map(select).filter((v): v is number => v != null);
  const hasData = values.length > 0;
  const max = Math.max(floorMax, ...values, ...refs.map((r) => r.v));

  const x = (t: number) => Math.max(0, Math.min(W, ((t - t0) / windowMs) * W));
  const y = (v: number) => H - (v / max) * (H - 12) - 6;

  const linePts = windowed
    .map((p) => {
      const v = select(p);
      return v == null ? null : `${x(p.t).toFixed(1)},${y(v).toFixed(1)}`;
    })
    .filter(Boolean)
    .join(' ');

  // Optional EWMA overlay (carries across nulls), to read the trend through jitter.
  let ewma: number | null = null;
  const ewmaPts =
    smooth == null
      ? ''
      : windowed
          .map((p) => {
            const v = select(p);
            if (v == null) return null;
            ewma = ewma == null ? v : smooth * v + (1 - smooth) * ewma;
            return `${x(p.t).toFixed(1)},${y(ewma).toFixed(1)}`;
          })
          .filter(Boolean)
          .join(' ');

  const last = [...windowed].reverse().find((p) => select(p) != null);
  const lastV = last ? select(last) : null;

  return (
    <div>
      <div className="mb-1 flex items-baseline gap-2">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-gray-400">
          {title}
        </span>
        <span className="font-mono text-[12px] font-semibold text-gray-800">
          {lastV == null ? '—' : lastV.toFixed(digits)}
          <span className="ml-0.5 text-[10px] font-normal text-gray-400">{unit}</span>
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none">
        {/* dashed reference lines (expected_hz / 2% / 5%) */}
        {refs.map((r) => (
          <line
            key={r.label}
            x1={0}
            x2={W}
            y1={y(r.v)}
            y2={y(r.v)}
            stroke={r.color}
            strokeWidth={1}
            strokeDasharray="4 3"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {/* REC / STOP vertical markers */}
        {markers
          .filter((mk) => mk.t >= t0)
          .map((mk, i) => (
            <line
              key={`${mk.t}-${i}`}
              x1={x(mk.t)}
              x2={x(mk.t)}
              y1={0}
              y2={H}
              stroke={mk.kind === 'REC' ? '#dc2626' : '#9ca3af'}
              strokeWidth={1}
              strokeDasharray={mk.kind === 'REC' ? undefined : '2 2'}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        {linePts && (
          <polyline
            points={linePts}
            fill="none"
            stroke={color}
            strokeWidth={1.5}
            // When smoothing, the raw line is faint and the EWMA line is the bold one.
            strokeOpacity={ewmaPts ? 0.28 : 1}
            vectorEffect="non-scaling-stroke"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}
        {ewmaPts && (
          <polyline
            points={ewmaPts}
            fill="none"
            stroke={color}
            strokeWidth={1.75}
            vectorEffect="non-scaling-stroke"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}
        {!hasData && (
          <text x={W / 2} y={H / 2} textAnchor="middle" className="fill-gray-300 text-[12px]">
            No data yet
          </text>
        )}
      </svg>
    </div>
  );
}

export function LiveHealthGraph({
  topic,
  label,
  points,
  markers,
  onClose,
}: {
  topic: string;
  label: string;
  points: MetricSample[];
  markers: RecMarker[];
  onClose: () => void;
}) {
  const [windowId, setWindowId] = useState('1m');
  const windowMs = WINDOWS.find((w) => w.id === windowId)?.ms ?? 60_000;

  // 1 Hz clock so the window scrolls smoothly between SSE snapshots.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const t0 = now - windowMs;

  const latest = points.at(-1);
  const status = latest?.status ?? 'unknown';
  const samplesLost = latest?.samplesLost ?? 0;
  const expected = useMemo(
    () => [...points].reverse().find((p) => p.expected != null)?.expected ?? null,
    [points],
  );

  // Read the current learned baseline (OL-②.3) for THIS topic straight from the
  // SSE-fed metrics cache (no extra subscription, no payload decode) — it is not
  // carried on the accumulated history points. Only relevant when the topic has
  // no static expected_hz; a static rate always wins.
  const metricsQuery = useQuery<MetricsSnapshot>({
    queryKey: queryKeys.metrics,
    queryFn: () => {
      throw new Error('SSE-only cache: written by useEventStream');
    },
    enabled: false,
  });
  const current = metricsQuery.data?.topics.find((t) => t.name === topic);
  const baselineHz = expected == null ? (current?.baseline_hz ?? null) : null;
  const baselineState = expected == null ? (current?.baseline_state ?? null) : null;

  // Hz chart references the configured rate when set; otherwise the learned
  // baseline (dashed teal). The shortfall chart references the 2% / 5% status
  // thresholds so a crossing is read directly off the line.
  const hzRefs: RefLine[] = expected
    ? [{ v: expected, color: '#94a3b8', label: `expected ${expected} Hz` }]
    : baselineHz != null
      ? [{ v: baselineHz, color: '#14b8a6', label: `baseline ~${baselineHz.toFixed(1)} Hz` }]
      : [];
  const shortfallRefs: RefLine[] = [
    { v: DEFAULT_WARN_SHORTFALL_PCT, color: '#d97706', label: 'warn 2%' },
    { v: DEFAULT_DANGER_SHORTFALL_PCT, color: '#dc2626', label: 'danger 5%' },
  ];

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <SectionLabel>Topic health</SectionLabel>
        <StatusDot tone={statusTone(status)} />
        <span className="truncate font-mono text-[12.5px] font-semibold text-gray-800" title={topic}>
          {label}
        </span>
        <Badge tone={statusTone(status)}>{status}</Badge>
        {expected != null && (
          <span className="font-mono text-[11px] text-gray-400">expected {expected} Hz</span>
        )}
        {expected == null && baselineState != null && (
          <span
            className="font-mono text-[11px] text-gray-400"
            title="Learned Hz baseline (no static expected_hz). While learning the status stays unknown."
          >
            {baselineState === 'learning'
              ? 'baseline learning…'
              : `baseline ~${baselineHz?.toFixed(1) ?? '—'} Hz (${baselineState})`}
          </span>
        )}
        {samplesLost > 0 && (
          <span title="DDS-reported dropped samples (real loss, not shortfall)">
            <Badge tone="red">{samplesLost} lost</Badge>
          </span>
        )}
        <div className="flex-1" />
        <div className="flex gap-[3px] rounded-control border border-gray-200 bg-gray-100 p-1">
          {WINDOWS.map((w) => (
            <button
              key={w.id}
              type="button"
              onClick={() => setWindowId(w.id)}
              className={cn(
                'rounded-chip px-2.5 py-0.5 text-[11px] font-medium transition-colors',
                w.id === windowId ? 'bg-white text-teal-700 shadow-sm' : 'text-gray-500',
              )}
            >
              {w.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="close health graph"
          className="rounded-control border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-500 hover:bg-gray-50"
        >
          Close
        </button>
      </div>

      <Sparkline
        title="Frequency"
        unit="Hz"
        points={points}
        select={(s) => s.hz}
        t0={t0}
        windowMs={windowMs}
        floorMax={expected ? expected * 1.2 : baselineHz != null ? baselineHz * 1.2 : 10}
        digits={1}
        color="#0d9488"
        refs={hzRefs}
        markers={markers}
        smooth={0.4}
      />
      <Sparkline
        title="Shortfall vs expected"
        unit="%"
        points={points}
        select={(s) => s.shortfall}
        t0={t0}
        windowMs={windowMs}
        floorMax={8}
        digits={1}
        color="#f59e0b"
        refs={shortfallRefs}
        markers={markers}
      />
      <Sparkline
        title="Jitter (inter-arrival p95)"
        unit="ms"
        points={points}
        select={(s) => s.jitterP95}
        t0={t0}
        windowMs={windowMs}
        floorMax={50}
        digits={0}
        color="#0891b2"
        refs={[]}
        markers={markers}
      />

      <p className="text-[10.5px] leading-relaxed text-gray-400">
        Shortfall is observed throughput below the configured rate — not true message
        loss (ROS 2 has no sequence numbers). REC / STOP marks where recording
        started / stopped.
      </p>
    </Card>
  );
}
