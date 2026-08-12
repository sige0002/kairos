// Signals sub-view (v2 Monitor) — the v1 Probe tab's generic numeric-field live
// plotter, ported into the v2 skin. Capability is REAL and reused wholesale: the
// topic list / field introspection / multi-topic overlay SSE all come from
// features/probe (useProbeTopics · useProbeFields · useProbeSeries · UplotChart ·
// PALETTE) unchanged; the persisted (topic,field) series + rate/window live in
// the shared uiStore probe slice. Only the presentation is reimplemented here.
// Decoding stays isolated in the topic_probe service, so recording / monitoring
// are never affected (the >6-topic note keeps the v1 wording).

import { useEffect, useMemo, useState } from 'react';
import { Card, cn } from '../../../components/ui';
import { useUiStore, type ProbeWindowId } from '../../../store/uiStore';
import {
  useProbeFields,
  useProbeSeries,
  useProbeTopics,
  type ProbeStreamStatus,
} from '../../../features/probe/useProbe';
import type { ProbeSeries } from '../../../features/probe/types';
import { PALETTE, UplotChart, type UplotSeriesConf } from '../../../features/probe/UplotChart';

const HZ_OPTIONS = [1, 5, 10, 30];
const WINDOWS: { id: ProbeWindowId; label: string; sec: number }[] = [
  { id: '10s', label: '10s', sec: 10 },
  { id: '30s', label: '30s', sec: 30 },
  { id: '1m', label: '1m', sec: 60 },
];
const TOPIC_WARN = 6;

const STATUS_LABEL: Record<ProbeStreamStatus, string> = {
  idle: 'idle',
  connecting: 'connecting',
  open: 'live',
  closed: 'closed',
};
const STATUS_DOT: Record<ProbeStreamStatus, string> = {
  idle: 'bg-gray-300',
  connecting: 'bg-amber-500',
  open: 'bg-green-500',
  closed: 'bg-gray-300',
};

function shortTopic(topic: string): string {
  return topic.split('/').filter(Boolean).at(-1) ?? topic;
}
function seriesLabel(s: ProbeSeries): string {
  return `${shortTopic(s.topic)}·${s.field}`;
}

export function SignalsView() {
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

  // Series + rate/window in the shared persistent store (survives a tab unmount);
  // pause stays local (a remount reopens the streams anyway).
  const series = useUiStore((s) => s.probeSeries);
  const addProbeSeries = useUiStore((s) => s.addProbeSeries);
  const removeSeries = useUiStore((s) => s.removeProbeSeries);
  const clearSeries = useUiStore((s) => s.clearProbeSeries);
  const hz = useUiStore((s) => s.probeHz);
  const setHz = useUiStore((s) => s.setProbeHz);
  const windowId = useUiStore((s) => s.probeWindowId);
  const setWindowId = useUiStore((s) => s.setProbeWindow);
  const [live, setLive] = useState(true);
  const windowSec = WINDOWS.find((w) => w.id === windowId)?.sec ?? 30;

  const addSeries = () => {
    if (!addTopic || !addField) return;
    addProbeSeries(addTopic, addField);
  };

  const { data, status } = useProbeSeries(series, live, hz, windowSec);
  const uplotSeries: UplotSeriesConf[] = series.map((s, i) => ({
    label: seriesLabel(s),
    stroke: PALETTE[i % PALETTE.length]!,
  }));
  const distinctTopics = useMemo(() => new Set(series.map((s) => s.topic)).size, [series]);

  return (
    <div className="flex flex-1 flex-col gap-2.5 lg:min-h-0">
      <Card className="flex shrink-0 flex-col">
        <div className="flex flex-wrap items-end gap-3 px-[18px] py-3.5">
          <label className="flex flex-col gap-1">
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-gray-500">
              Topic
            </span>
            <select
              data-testid="signals-topic"
              aria-label="signal topic"
              value={addTopic ?? ''}
              onChange={(e) => {
                setAddTopic(e.target.value || null);
                setAddField(null);
              }}
              className="min-w-[15rem] rounded-control border border-gray-200 px-2 py-1 text-[12.5px] font-medium text-gray-700 focus:border-teal-500 focus:outline-none"
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
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-gray-500">
              Field
            </span>
            <select
              data-testid="signals-field"
              aria-label="signal field"
              value={addField ?? ''}
              disabled={!addTopic || fields.length === 0}
              onChange={(e) => setAddField(e.target.value || null)}
              className="min-w-[13rem] rounded-control border border-gray-200 px-2 py-1 text-[12.5px] font-medium text-gray-700 focus:border-teal-500 focus:outline-none disabled:opacity-50"
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
            data-testid="signals-add"
            onClick={addSeries}
            disabled={!addTopic || !addField}
            className="rounded-control bg-teal-700 px-3.5 py-1.5 text-[12.5px] font-semibold text-white hover:bg-teal-800 disabled:opacity-50"
          >
            + Add series
          </button>

          <div className="ml-auto flex items-end gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-gray-500">
                Window
              </span>
              <div className="flex gap-[3px] rounded-control border border-gray-200 bg-gray-100 p-1">
                {WINDOWS.map((w) => (
                  <button
                    key={w.id}
                    type="button"
                    data-testid={`signals-window-${w.id}`}
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
              <span className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-gray-500">
                Rate
              </span>
              <select
                aria-label="signal rate"
                value={hz}
                onChange={(e) => setHz(Number(e.target.value))}
                className="rounded-control border border-gray-200 px-2 py-1 text-[12.5px] font-medium text-gray-700 focus:border-teal-500 focus:outline-none"
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
              data-testid="signals-pause"
              onClick={() => setLive((v) => !v)}
              disabled={series.length === 0}
              className={cn(
                'rounded-control px-3.5 py-1.5 text-[12.5px] font-semibold transition-colors disabled:opacity-50',
                live
                  ? 'border border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
                  : 'bg-teal-700 text-white hover:bg-teal-800',
              )}
            >
              {live ? 'Pause' : 'Resume'}
            </button>
          </div>
        </div>

        {series.length > 0 && (
          <div className="border-t border-gray-100 px-[18px] py-2.5">
            <div className="mb-1.5 flex items-center gap-2.5">
              <h3 className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-gray-500">
                Series ({series.length})
              </h3>
              <button
                type="button"
                onClick={clearSeries}
                className="text-[11px] font-medium text-gray-500 hover:text-red-600"
              >
                Clear all
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {series.map((s, i) => (
                // A series label is `<topic leaf> · <field path>`, and both
                // halves come from the robot: 120-char topics and 88-char field
                // paths are ordinary on a real arm. Unbounded, one chip grows
                // wider than the row, `flex-wrap` cannot break it, and the whole
                // PAGE gains a horizontal scrollbar (measured: 166px of it at
                // 1280x800/150% zoom). Capped at the row and truncated — the
                // full `topic · field` stays on the title, so nothing is lost,
                // and the remove button stays inside the chip where it belongs.
                <span
                  key={s.id}
                  data-testid={`signals-chip-${s.id}`}
                  className="inline-flex max-w-full min-w-0 items-center gap-2 rounded-control border border-gray-200 bg-white py-1 pl-2 pr-1 text-[11.5px]"
                >
                  <span
                    className="inline-block h-[3px] w-3 shrink-0 rounded-sm"
                    style={{ background: PALETTE[i % PALETTE.length] }}
                  />
                  <span
                    className="min-w-0 truncate font-mono text-gray-700"
                    title={`${s.topic} · ${s.field}`}
                  >
                    {seriesLabel(s)}
                  </span>
                  <button
                    type="button"
                    aria-label={`remove ${seriesLabel(s)}`}
                    title="Remove series"
                    onClick={() => removeSeries(s.id)}
                    className="flex h-5 w-5 items-center justify-center rounded text-[14px] leading-none text-gray-500 hover:bg-red-50 hover:text-red-600"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}

        {distinctTopics > TOPIC_WARN && (
          <p className="border-t border-amber-100 bg-amber-50 px-[18px] py-1.5 text-[11px] text-amber-700">
            {distinctTopics} topics subscribed (&gt;{TOPIC_WARN}). Decoding stays isolated in
            topic_probe (recording / monitoring unaffected), but the probe preview may lag.
          </p>
        )}
      </Card>

      <Card className="flex flex-1 flex-col lg:min-h-0">
        <div className="flex items-center gap-2.5 border-b border-gray-100 px-[18px] py-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
            Signals
          </h2>
          <div className="flex-1" />
          <span className="inline-flex items-center gap-1.5 text-[11.5px] text-gray-500">
            <span className={cn('h-[7px] w-[7px] rounded-full', STATUS_DOT[status])} />
            <span data-testid="signals-status" className="font-mono">
              {STATUS_LABEL[status]}
            </span>
          </span>
        </div>
        {/* uPlot's own bottom legend is KEPT here (unlike the Monitor frequency
            charts, which scope it away): it is the hover readout, the only place
            the value under the cursor is shown. But its series cell is one
            unbreakable line of `<topic leaf> · <field path>`, and on a real arm
            that is well over 100 characters — enough to push the whole PAGE into
            horizontal scroll (measured: 207px overhanging at 1280x800/150%
            zoom). Capped and ellipsised per cell; the chips above carry the same
            names in full, with the untruncated pair on their title. */}
        <style>
          {/* The cap goes on the cell, the ellipsis on `.u-label` — uPlot puts
              the text in that child div, and `text-overflow` only marks the cut
              on the element whose own content overflows. On the `th` alone the
              text was clipped with nothing to say so. */}
          {'.signals-chart .u-legend th { max-width: 22ch; } ' +
            '.signals-chart .u-legend .u-label { display: block; max-width: 22ch; ' +
            'overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }'}
        </style>
        <div className="signals-chart min-h-0 flex-1 px-[18px] py-3">
          {series.length === 0 ? (
            <p
              data-testid="signals-empty"
              className="flex h-full items-center justify-center text-center text-[12px] leading-relaxed text-gray-500"
            >
              Add a topic + field series to start plotting. Add several — even across topics — to
              overlay them on one chart.
            </p>
          ) : (
            <UplotChart data={data} series={uplotSeries} height={280} />
          )}
        </div>
      </Card>
    </div>
  );
}
