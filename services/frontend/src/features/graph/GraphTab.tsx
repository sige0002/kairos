// Graph tab: time-series topic health, built as ADD/REMOVE panels (like the
// Stream tab's camera panes). Each panel picks one *metric* and any number of
// *topics* (series) to overlay. The metric set is a data-driven registry, so
// graphing a new element later is a one-line addition.
//
// Robot-independence: the default metrics (Frequency / Bandwidth / Max gap) are
// computed for every topic with no per-robot config, and the topic list comes
// from whatever is actually flowing — never hardcoded names. `Rate vs expected`
// needs `expected_hz`. Latency / loss are NOT offered: the non-intrusive monitor
// never decodes payloads, so neither can be produced live (see the METRICS note
// below) — per-run loss is available post-hoc in the Recordings tab instead.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { RuntimeConfig } from '../../config';
import { Card, SectionLabel, cn } from '../../components/ui';
import { useMetricHistory, type MetricSample } from './useMetricHistory';

// Distinct line colours, assigned per panel by series order (so every chart's
// own lines are distinct even if two panels share a topic).
const PALETTE = ['#0d9488', '#0891b2', '#d97706', '#fb7185', '#16a34a', '#7c3aed'];
const DEFAULT_COLOR = '#0d9488';
const MAX_SERIES = PALETTE.length;

function paletteColor(i: number): string {
  return PALETTE[i % PALETTE.length] ?? DEFAULT_COLOR;
}

interface GraphMetric {
  key: string;
  title: string;
  unit: string;
  select: (s: MetricSample) => number | null;
  digits: number;
  /** A sensible fixed ceiling; charts also auto-grow to fit the data. */
  floorMax: number;
  /** Shown inside the chart when there is no data (e.g. why rate is empty). */
  note?: string;
}

// Only metrics the non-intrusive monitor can actually produce. Latency & loss
// were dropped (plan.md + codex review): with `raw=True` (no payload decode)
// `stamp_delay_ms` is never populated and `loss_rate` is never computed, and
// DDS sample-lost ≠ rosbag loss — a permanently-empty chart is worse than none.
// (Future: a sampled std_msgs/Header partial-decode "stamp age" metric, and a
// post-hoc per-run loss report in Recordings — tracked in task.md.)
const METRICS: GraphMetric[] = [
  { key: 'hz', title: 'Frequency', unit: 'Hz', select: (s) => s.hz, digits: 1, floorMax: 10 },
  { key: 'bw', title: 'Bandwidth', unit: 'MB/s', select: (s) => s.bw, digits: 2, floorMax: 1 },
  { key: 'gap', title: 'Max gap', unit: 'ms', select: (s) => s.gap, digits: 0, floorMax: 100 },
  {
    key: 'rate',
    title: 'Rate vs expected',
    unit: '%',
    select: (s) => s.rate,
    digits: 0,
    floorMax: 100,
    note: 'Only computed for topics with expected_hz set.',
  },
];

const WINDOWS: { id: string; label: string; ms: number }[] = [
  { id: '30s', label: '30s', ms: 30_000 },
  { id: '1m', label: '1m', ms: 60_000 },
  { id: '5m', label: '5m', ms: 300_000 },
];

function shortName(topic: string): string {
  const parts = topic.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? topic;
}

// Disambiguate labels: use the shortest trailing path segment(s) that is unique
// across the topic set, so two topics ending `/compressed` (or `/image`) don't
// render as the same name (plan.md graph item). Falls back to the full path.
function buildLabelMap(topics: string[]): Map<string, string> {
  const tail = (t: string, n: number) => t.split('/').filter(Boolean).slice(-n).join('/') || t;
  const maxDepth = Math.max(1, ...topics.map((t) => t.split('/').filter(Boolean).length));
  const map = new Map<string, string>();
  for (const t of topics) {
    let label = t; // fall back to the full path if nothing else is unique
    for (let d = 1; d <= maxDepth; d++) {
      const cand = tail(t, d);
      if (!topics.some((o) => o !== t && tail(o, d) === cand)) {
        label = cand;
        break;
      }
    }
    map.set(t, label);
  }
  return map;
}

interface Series {
  full: string;
  name: string;
  color: string;
  points: MetricSample[];
}

function Chart({
  metric,
  series,
  windowMs,
  now,
}: {
  metric: GraphMetric;
  series: Series[];
  windowMs: number;
  now: number;
}) {
  const W = 600;
  const H = 170;
  const t0 = now - windowMs;

  // Only points inside the window are scaled, drawn, and summed into the y-axis
  // max — otherwise older points clamp onto x=0 and inflate the scale.
  const windowed = series.map((s) => ({
    ...s,
    points: s.points.filter((p) => p.t >= t0),
  }));

  const hasData = windowed.some((s) => s.points.some((p) => metric.select(p) != null));

  const max = Math.max(
    metric.floorMax,
    ...windowed.flatMap((s) => s.points.map((p) => metric.select(p) ?? 0)),
  );

  const toXY = (p: MetricSample): [number, number] | null => {
    const v = metric.select(p);
    if (v === null || v === undefined) return null;
    const x = ((p.t - t0) / windowMs) * W;
    const y = H - (v / max) * (H - 10) - 5;
    return [Math.max(0, Math.min(W, x)), y];
  };

  // No data in-window: explain (e.g. rate needs expected_hz) rather than a blank.
  const showNote = !hasData;

  return (
    <>
      <div className="mb-2.5 flex flex-wrap gap-x-3 gap-y-1">
        {windowed.length === 0 ? (
          <span className="font-mono text-[10.5px] text-gray-400">No series</span>
        ) : (
          windowed.map((s) => {
            const last = [...s.points].reverse().find((p) => metric.select(p) !== null);
            const v = last ? metric.select(last) : null;
            return (
              <span key={s.full} className="flex items-center gap-1.5">
                <span
                  className="inline-block h-[3px] w-3 rounded-sm"
                  style={{ background: s.color }}
                />
                <span className="font-mono text-[10.5px] text-gray-500">{s.name}</span>
                <span className="font-mono text-[10.5px] font-semibold text-gray-700">
                  {v === null || v === undefined ? '—' : v.toFixed(metric.digits)}
                </span>
              </span>
            );
          })
        )}
      </div>
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none">
          {[0.25, 0.5, 0.75].map((f) => (
            <line key={f} x1={0} x2={W} y1={H * f} y2={H * f} stroke="#f1f3f5" strokeWidth={1} />
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
                key={s.full}
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
        {showNote && (
          <div className="absolute inset-0 flex items-center justify-center p-4">
            <p className="max-w-[80%] text-center text-[11.5px] leading-relaxed text-gray-400">
              {metric.note ?? 'No data yet.'}
            </p>
          </div>
        )}
      </div>
    </>
  );
}

interface PanelState {
  id: number;
  metric: string;
  /** 'all' auto-tracks every flowing topic; an array is an explicit pick. */
  topics: 'all' | string[];
}

function GraphPanel({
  panel,
  availableTopics,
  labelFor,
  history,
  windowMs,
  now,
  removable,
  onChange,
  onRemove,
}: {
  panel: PanelState;
  availableTopics: string[];
  labelFor: (topic: string) => string;
  history: Map<string, MetricSample[]>;
  windowMs: number;
  now: number;
  removable: boolean;
  onChange: (next: PanelState) => void;
  onRemove: () => void;
}) {
  const metric = METRICS.find((m) => m.key === panel.metric) ?? METRICS[0]!;

  const selected = useMemo(
    () =>
      panel.topics === 'all'
        ? availableTopics
        : availableTopics.filter((t) => panel.topics.includes(t)),
    [panel.topics, availableTopics],
  );
  const shown = selected.slice(0, MAX_SERIES);
  const overflow = selected.length - shown.length;

  const series: Series[] = shown.map((name, i) => ({
    full: name,
    name: labelFor(name),
    color: paletteColor(i),
    points: history.get(name) ?? [],
  }));

  const toggleTopic = (name: string) => {
    const cur = new Set(panel.topics === 'all' ? availableTopics : panel.topics);
    if (cur.has(name)) cur.delete(name);
    else cur.add(name);
    onChange({ ...panel, topics: [...cur] });
  };

  return (
    <Card className="flex flex-col gap-2.5 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="metric"
          className="rounded-control border border-gray-200 px-2 py-1 text-sm font-medium text-gray-700 focus:border-teal-500 focus:outline-none"
          value={metric.key}
          onChange={(e) => onChange({ ...panel, metric: e.target.value })}
        >
          {METRICS.map((m) => (
            <option key={m.key} value={m.key}>
              {m.title}
              {m.key === 'rate' ? ' (needs expected_hz)' : ''}
            </option>
          ))}
        </select>
        <span className="font-mono text-[11px] text-gray-400">{metric.unit}</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => onChange({ ...panel, topics: 'all' })}
          className="rounded-control border border-gray-200 px-2 py-1 text-xs font-medium text-gray-500 hover:bg-gray-50"
        >
          All
        </button>
        <button
          type="button"
          onClick={() => onChange({ ...panel, topics: [] })}
          className="rounded-control border border-gray-200 px-2 py-1 text-xs font-medium text-gray-500 hover:bg-gray-50"
        >
          Clear
        </button>
        {removable && (
          <button
            type="button"
            onClick={onRemove}
            aria-label="remove graph"
            className="rounded-control border border-red-200 px-2.5 py-1 text-xs font-semibold text-red-700 hover:bg-red-50"
          >
            Remove
          </button>
        )}
      </div>

      {/* Series toggles: every flowing topic; selected ones carry their line
          colour (or grey when beyond the {MAX_SERIES}-line display cap). */}
      {availableTopics.length === 0 ? (
        <p className="text-[11.5px] text-gray-400">Waiting for metrics.</p>
      ) : (
        <div className="flex max-h-[78px] flex-wrap gap-1.5 overflow-y-auto">
          {availableTopics.map((t) => {
            const idx = shown.indexOf(t);
            const on = selected.includes(t);
            const swatch = idx >= 0 ? paletteColor(idx) : on ? '#cbd5e1' : 'transparent';
            return (
              <button
                key={t}
                type="button"
                aria-pressed={on}
                onClick={() => toggleTopic(t)}
                title={t}
                className={cn(
                  'flex items-center gap-1.5 rounded-chip border px-2 py-0.5 font-mono text-[10.5px] transition-colors',
                  on
                    ? 'border-gray-300 bg-white text-gray-700'
                    : 'border-gray-200 bg-gray-50 text-gray-400 hover:text-gray-600',
                )}
              >
                <span
                  className="inline-block h-2 w-2 rounded-sm border border-gray-300"
                  style={{ background: swatch }}
                />
                {labelFor(t)}
              </button>
            );
          })}
        </div>
      )}
      {overflow > 0 && (
        <p className="text-[10.5px] text-amber-600">
          Showing at most {MAX_SERIES} series ({overflow} hidden). Narrow the topic
          selection.
        </p>
      )}

      <Chart metric={metric} series={series} windowMs={windowMs} now={now} />
    </Card>
  );
}

export function GraphTab({ config }: { config: RuntimeConfig }) {
  const [windowId, setWindowId] = useState('1m');
  const [paused, setPaused] = useState(false);
  const windowMs = WINDOWS.find((w) => w.id === windowId)?.ms ?? 60_000;

  const { history, topics } = useMetricHistory(config, paused);
  const labelMap = useMemo(() => buildLabelMap(topics), [topics]);
  const labelFor = (t: string) => labelMap.get(t) ?? shortName(t);

  const nextId = useRef(3);
  const [panels, setPanels] = useState<PanelState[]>(() => [
    { id: 0, metric: 'hz', topics: 'all' },
    { id: 1, metric: 'bw', topics: 'all' },
    { id: 2, metric: 'gap', topics: 'all' },
  ]);

  // A 1 Hz clock so the time axis scrolls smoothly between SSE snapshots (and
  // while paused). Without it `now` only advanced on each snapshot, freezing the
  // live window's right edge.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex flex-col gap-[18px]">
      <div className="flex flex-wrap items-center gap-3">
        <SectionLabel>Graph</SectionLabel>
        <span className="font-mono text-[11.5px] text-gray-400">
          {topics.length} topics · {panels.length} graphs · {windowId} window
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
          {paused ? 'Resume' : 'Pause'}
        </button>
        <button
          type="button"
          onClick={() =>
            setPanels((ps) => [...ps, { id: nextId.current++, metric: 'hz', topics: 'all' }])
          }
          className="rounded-control bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white shadow-card hover:bg-teal-700"
        >
          + Add graph
        </button>
      </div>

      {panels.length === 0 ? (
        <Card className="p-8 text-center text-sm text-gray-500">
          No graphs. Use "+ Add graph" to create one.
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-[18px] md:grid-cols-2">
          {panels.map((panel) => (
            <GraphPanel
              key={panel.id}
              panel={panel}
              availableTopics={topics}
              labelFor={labelFor}
              history={history}
              windowMs={windowMs}
              now={now}
              removable={panels.length > 1}
              onChange={(next) =>
                setPanels((ps) => ps.map((p) => (p.id === panel.id ? next : p)))
              }
              onRemove={() => setPanels((ps) => ps.filter((p) => p.id !== panel.id))}
            />
          ))}
        </div>
      )}
    </div>
  );
}
