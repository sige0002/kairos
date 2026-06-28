// Probe tab (OL-3.3): generic numeric-field live plotter with OVERLAY. Add any
// number of (topic, field) series and plot them on one chart. Series can span
// different topics (e.g. left arm / right arm) — the topic_probe service holds a
// ref-counted subscription per topic and streams multi-field samples; the chart
// is uPlot (axis ticks · legend · crosshair). Decoding stays isolated in
// topic_probe, so recording / monitoring are never affected.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Card, CardHeader, StatusDot, cn } from '../../components/ui';
import type { Tone } from '../../components/ui';
import {
  useProbeFields,
  useProbeSeries,
  useProbeTopics,
  type ProbeStreamStatus,
} from './useProbe';
import type { ProbeSeries } from './types';
import { UplotChart, type UplotSeriesConf } from './UplotChart';

const PALETTE = [
  '#0d9488',
  '#0891b2',
  '#d97706',
  '#fb7185',
  '#16a34a',
  '#7c3aed',
  '#dc2626',
  '#2563eb',
];
const HZ_OPTIONS = [1, 5, 10, 30];
const WINDOWS: { id: string; label: string; sec: number }[] = [
  { id: '10s', label: '10s', sec: 10 },
  { id: '30s', label: '30s', sec: 30 },
  { id: '1m', label: '1m', sec: 60 },
];
const TOPIC_WARN = 6;

const STATUS_TONE: Record<ProbeStreamStatus, Tone> = {
  idle: 'gray',
  connecting: 'amber',
  open: 'green',
  closed: 'gray',
};

function shortTopic(topic: string): string {
  return topic.split('/').filter(Boolean).at(-1) ?? topic;
}
function seriesLabel(s: ProbeSeries): string {
  return `${shortTopic(s.topic)}·${s.field}`;
}

export function ProbeTab() {
  const topicsQuery = useProbeTopics();
  const topics = topicsQuery.data ?? [];

  // Add-series form: pick a topic, then one of its numeric fields, then "Add".
  const [addTopic, setAddTopic] = useState<string | null>(null);
  const [addField, setAddField] = useState<string | null>(null);
  const fieldsQuery = useProbeFields(addTopic);
  const fields = fieldsQuery.data?.fields ?? [];
  useEffect(() => {
    if (addField && fields.includes(addField)) return;
    setAddField(fields[0] ?? null);
  }, [fields, addField]);

  const [series, setSeries] = useState<ProbeSeries[]>([]);
  const [live, setLive] = useState(true);
  const [hz, setHz] = useState(10);
  const [windowId, setWindowId] = useState('30s');
  const windowSec = WINDOWS.find((w) => w.id === windowId)?.sec ?? 30;
  const idRef = useRef(0);

  const addSeries = () => {
    if (!addTopic || !addField) return;
    if (series.some((s) => s.topic === addTopic && s.field === addField)) return; // no dupes
    setSeries((prev) => [
      ...prev,
      { id: `s${idRef.current++}`, topic: addTopic, field: addField },
    ]);
  };
  const removeSeries = (id: string) =>
    setSeries((prev) => prev.filter((s) => s.id !== id));

  const { data, status } = useProbeSeries(series, live, hz, windowSec);

  const uplotSeries: UplotSeriesConf[] = series.map((s, i) => ({
    label: seriesLabel(s),
    stroke: PALETTE[i % PALETTE.length]!,
  }));

  const distinctTopics = useMemo(
    () => new Set(series.map((s) => s.topic)).size,
    [series],
  );

  return (
    <div className="flex flex-col gap-[18px]">
      <Card>
        <CardHeader
          title="Probe — overlay"
          right={
            <span className="flex items-center gap-2">
              <StatusDot tone={STATUS_TONE[status]} />
              <span className="font-mono text-[11px] text-gray-500">{status}</span>
            </span>
          }
        />
        <div className="flex flex-wrap items-end gap-3 px-[18px] py-4">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-gray-400">
              Topic
            </span>
            <select
              aria-label="probe topic"
              value={addTopic ?? ''}
              onChange={(e) => {
                setAddTopic(e.target.value || null);
                setAddField(null);
              }}
              className="min-w-[15rem] rounded-control border border-gray-200 px-2 py-1 text-sm font-medium text-gray-700 focus:border-teal-500 focus:outline-none"
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
              value={addField ?? ''}
              disabled={!addTopic || fields.length === 0}
              onChange={(e) => setAddField(e.target.value || null)}
              className="min-w-[13rem] rounded-control border border-gray-200 px-2 py-1 text-sm font-medium text-gray-700 focus:border-teal-500 focus:outline-none disabled:opacity-50"
            >
              <option value="">
                {!addTopic
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
            onClick={addSeries}
            disabled={!addTopic || !addField}
            className="rounded-control bg-teal-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
          >
            + Add series
          </button>

          <div className="ml-auto flex items-end gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-gray-400">
                Window
              </span>
              <div className="flex gap-[3px] rounded-control border border-gray-200 bg-gray-100 p-1">
                {WINDOWS.map((w) => (
                  <button
                    key={w.id}
                    type="button"
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
            </div>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-gray-400">
                Rate
              </span>
              <select
                aria-label="probe rate"
                value={hz}
                onChange={(e) => setHz(Number(e.target.value))}
                className="rounded-control border border-gray-200 px-2 py-1 text-sm font-medium text-gray-700 focus:border-teal-500 focus:outline-none"
              >
                {HZ_OPTIONS.map((h) => (
                  <option key={h} value={h}>
                    {h} Hz
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => setLive((v) => !v)}
              disabled={series.length === 0}
              className={cn(
                'rounded-control px-4 py-1.5 text-sm font-semibold transition-colors disabled:opacity-50',
                live
                  ? 'border border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
                  : 'bg-teal-600 text-white hover:bg-teal-700',
              )}
            >
              {live ? 'Pause' : 'Resume'}
            </button>
          </div>
        </div>

        {series.length > 0 && (
          <div className="px-[18px] pb-4">
            <div className="mb-1.5 flex items-center gap-2.5">
              <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-gray-400">
                Series ({series.length})
              </span>
              <button
                type="button"
                onClick={() => setSeries([])}
                className="text-[11px] font-medium text-gray-400 hover:text-red-600"
              >
                Clear all
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {series.map((s, i) => (
                <span
                  key={s.id}
                  className="inline-flex items-center gap-2 rounded-control border border-gray-200 bg-white py-1 pl-2 pr-1 text-[11.5px]"
                >
                  <span
                    className="inline-block h-[3px] w-3 rounded-sm"
                    style={{ background: PALETTE[i % PALETTE.length] }}
                  />
                  <span className="font-mono text-gray-700" title={`${s.topic} · ${s.field}`}>
                    {seriesLabel(s)}
                  </span>
                  <button
                    type="button"
                    aria-label={`remove ${seriesLabel(s)}`}
                    title="Remove series"
                    onClick={() => removeSeries(s.id)}
                    className="flex h-5 w-5 items-center justify-center rounded text-[14px] leading-none text-gray-400 hover:bg-red-50 hover:text-red-600"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}

        {distinctTopics > TOPIC_WARN && (
          <p className="px-[18px] pb-3 text-[11px] text-amber-600">
            <Badge tone="amber">{distinctTopics} topics</Badge> subscribed (&gt;{TOPIC_WARN}).
            Decoding stays isolated in topic_probe (recording / monitoring unaffected), but the
            probe preview may lag.
          </p>
        )}
      </Card>

      <Card className="px-[18px] py-4">
        {series.length === 0 ? (
          <p className="py-8 text-center text-[11.5px] text-gray-400">
            Add a topic + field series to start plotting. Add several — even across topics — to
            overlay them on one chart.
          </p>
        ) : (
          <UplotChart data={data} series={uplotSeries} />
        )}
      </Card>
    </div>
  );
}
