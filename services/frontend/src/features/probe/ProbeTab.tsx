// Probe tab (OL-3.3): generic numeric-field live plotter. Flow: pick a topic ->
// pick one of its numeric fields -> live plot. The topic_probe service (a SEPARATE
// ROS service, isolated so its decoding can never affect recording/monitoring)
// subscribes to the one selected topic, decodes it, and streams throttled samples.
//
// Robot-independent by construction: topics come from whatever is on the graph
// and fields are introspected from the live message type — never hardcoded.

import { useEffect, useState } from 'react';
import { Card, CardHeader, StatusDot, cn } from '../../components/ui';
import type { Tone } from '../../components/ui';
import { useProbeFields, useProbeStream, useProbeTopics } from './useProbe';
import type { ProbePoint } from './types';
import type { ProbeStreamStatus } from './useProbe';

const W = 600;
const H = 200;

const STATUS_TONE: Record<ProbeStreamStatus, Tone> = {
  idle: 'gray',
  connecting: 'amber',
  open: 'green',
  closed: 'gray',
};

/** Map the value buffer to an SVG polyline that auto-fits its own min/max. */
function chartPoints(points: ProbePoint[]): string {
  const vals = points
    .map((p) => p.value)
    .filter((v): v is number => v !== null && Number.isFinite(v));
  if (vals.length < 2) return '';
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const n = points.length;
  const coords: string[] = [];
  points.forEach((p, i) => {
    if (p.value === null || !Number.isFinite(p.value)) return;
    const x = (i / (n - 1)) * W;
    const y = H - ((p.value - min) / span) * H;
    coords.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  });
  return coords.join(' ');
}

export function ProbeTab() {
  const topicsQuery = useProbeTopics();
  const [topic, setTopic] = useState<string | null>(null);
  const [field, setField] = useState<string | null>(null);
  const [live, setLive] = useState(true);

  const fieldsQuery = useProbeFields(topic);
  const stream = useProbeStream(topic, field, live);

  // When the field list resolves, default to the first field if none chosen.
  const fields = fieldsQuery.data?.fields ?? [];
  useEffect(() => {
    if (field && fields.includes(field)) return;
    setField(fields[0] ?? null);
  }, [fields, field]);

  const topics = topicsQuery.data ?? [];
  const line = chartPoints(stream.points);
  const hasData = line !== '';

  return (
    <div className="flex flex-col gap-[18px]">
      <Card>
        <CardHeader
          title="Probe"
          right={
            <span className="flex items-center gap-2">
              <StatusDot tone={STATUS_TONE[stream.status]} />
              <span className="font-mono text-[11px] text-gray-500">
                {stream.status}
              </span>
            </span>
          }
        />
        <div className="flex flex-wrap items-end gap-4 px-[18px] py-4">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-gray-400">
              Topic
            </span>
            <select
              aria-label="probe topic"
              value={topic ?? ''}
              onChange={(e) => {
                setTopic(e.target.value || null);
                setField(null);
              }}
              className="min-w-[16rem] rounded-control border border-gray-200 px-2 py-1 text-sm font-medium text-gray-700 focus:border-teal-500 focus:outline-none"
            >
              <option value="">
                {topicsQuery.isPending ? 'Loading topics…' : 'Select a topic…'}
              </option>
              {topics.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-gray-400">
              Field
            </span>
            <select
              aria-label="probe field"
              value={field ?? ''}
              disabled={!topic || fields.length === 0}
              onChange={(e) => setField(e.target.value || null)}
              className="min-w-[14rem] rounded-control border border-gray-200 px-2 py-1 text-sm font-medium text-gray-700 focus:border-teal-500 focus:outline-none disabled:opacity-50"
            >
              <option value="">
                {!topic
                  ? 'Pick a topic first'
                  : fieldsQuery.isPending
                    ? 'Introspecting…'
                    : fields.length === 0
                      ? 'No numeric fields'
                      : 'Select a field…'}
              </option>
              {fields.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            onClick={() => setLive((v) => !v)}
            disabled={!topic || !field}
            className={cn(
              'rounded-control px-4 py-1.5 text-sm font-semibold transition-colors disabled:opacity-50',
              live
                ? 'border border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
                : 'bg-teal-600 text-white hover:bg-teal-700',
            )}
          >
            {live ? 'Pause' : 'Resume'}
          </button>

          <div className="ml-auto flex flex-col items-end">
            <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-gray-400">
              Latest
            </span>
            <span className="font-mono text-lg font-semibold text-gray-800">
              {stream.latest === null ? '—' : stream.latest.toFixed(3)}
            </span>
          </div>
        </div>
      </Card>

      <Card className="px-[18px] py-4">
        {fieldsQuery.data?.type && (
          <p className="mb-2 font-mono text-[11px] text-gray-400">
            {topic} · {fieldsQuery.data.type}
            {field ? ` · ${field}` : ''}
          </p>
        )}
        <div className="relative">
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
            {hasData && (
              <polyline
                points={line}
                fill="none"
                stroke="#0d9488"
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            )}
          </svg>
          {!hasData && (
            <div className="absolute inset-0 flex items-center justify-center p-4">
              <p className="max-w-[80%] text-center text-[11.5px] leading-relaxed text-gray-400">
                {!topic
                  ? 'Select a topic and a numeric field to start plotting.'
                  : !field
                    ? (fieldsQuery.data?.reason ?? 'No numeric field selected.')
                    : !live
                      ? 'Paused.'
                      : 'Waiting for samples…'}
              </p>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
