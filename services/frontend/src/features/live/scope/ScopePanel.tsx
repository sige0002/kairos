// One Scope band panel — either a Health panel (monitor-derived, no payload
// decode: Frequency / Shortfall / Jitter, multi-topic overlay) or a Signal
// panel (topic_probe-derived decoded numeric fields, multi-topic x multi-field
// overlay). Both share the same card shell, a removable-chip series list, and
// a uPlot chart with REC/STOP markers overlaid.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Card } from '../../../components/ui';
import type {
  ScopeHealthPanel,
  ScopeMetric,
  ScopePanel as ScopePanelState,
  ScopePanelPatch,
  ScopeSignalPanel,
} from '../../../store/uiStore';
import type { MetricSample } from '../../graph/useMetricHistory';
import { DEFAULT_DANGER_SHORTFALL_PCT, DEFAULT_WARN_SHORTFALL_PCT } from '../../monitor/thresholds';
import { useProbeFields, useProbeSeries, useProbeTopics } from '../../probe/useProbe';
import type { ProbeSeries } from '../../probe/types';
import { PALETTE, UplotChart, type ChartMarker, type RefLine, type UplotSeriesConf } from '../../probe/UplotChart';
import { healthAlignedData, latestExpected } from './scopeData';

const CHART_HEIGHT = 190;

function shortTopic(topic: string): string {
  return topic.split('/').filter(Boolean).at(-1) ?? topic;
}
function seriesLabel(s: ProbeSeries): string {
  return `${shortTopic(s.topic)}·${s.field}`;
}

function RemovePanelButton({ onRemove }: { onRemove: () => void }) {
  return (
    <button
      type="button"
      onClick={onRemove}
      aria-label="remove panel"
      title="Remove panel"
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[15px] leading-none text-gray-400 hover:bg-red-50 hover:text-red-600"
    >
      &times;
    </button>
  );
}

function SeriesChip({
  color,
  label,
  title,
  onRemove,
}: {
  color: string;
  label: string;
  title?: string;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-control border border-gray-200 bg-white py-1 pl-2 pr-1 text-[11.5px]">
      <span className="inline-block h-[3px] w-3 rounded-sm" style={{ background: color }} />
      <span className="font-mono text-gray-700" title={title}>
        {label}
      </span>
      <button
        type="button"
        aria-label={`remove ${label}`}
        title="Remove series"
        onClick={onRemove}
        className="flex h-5 w-5 items-center justify-center rounded text-[14px] leading-none text-gray-400 hover:bg-red-50 hover:text-red-600"
      >
        &times;
      </button>
    </span>
  );
}

const METRIC_OPTIONS: { id: ScopeMetric; label: string }[] = [
  { id: 'hz', label: 'Frequency (Hz)' },
  { id: 'shortfall', label: 'Shortfall vs expected (%)' },
  { id: 'jitter', label: 'Jitter p95 (ms)' },
];

function HealthScopePanel({
  panel,
  topics,
  history,
  windowSec,
  now,
  markers,
  onUpdate,
  onRemove,
}: {
  panel: ScopeHealthPanel;
  topics: string[];
  history: Map<string, MetricSample[]>;
  windowSec: number;
  now: number;
  markers: ChartMarker[];
  onUpdate: (patch: ScopePanelPatch) => void;
  onRemove: () => void;
}) {
  const [addTopic, setAddTopic] = useState('');
  const available = useMemo(
    () => topics.filter((t) => !panel.topics.includes(t)),
    [topics, panel.topics],
  );

  const addChip = () => {
    if (!addTopic) return;
    onUpdate({ topics: [...panel.topics, addTopic] });
    setAddTopic('');
  };
  const removeChip = (t: string) => onUpdate({ topics: panel.topics.filter((x) => x !== t) });

  const data = useMemo(
    () => healthAlignedData(history, panel.topics, panel.metric, windowSec, now),
    [history, panel.topics, panel.metric, windowSec, now],
  );
  const series: UplotSeriesConf[] = panel.topics.map((t, i) => ({
    label: shortTopic(t),
    stroke: PALETTE[i % PALETTE.length]!,
  }));

  // Reference lines: a single-topic Frequency panel shows that topic's latest
  // expected_hz (dashed gray); Shortfall always shows the 2%/5% status
  // thresholds; Jitter has no reference.
  const refLines: RefLine[] = useMemo(() => {
    if (panel.metric === 'shortfall') {
      return [
        { v: DEFAULT_WARN_SHORTFALL_PCT, color: '#d97706' },
        { v: DEFAULT_DANGER_SHORTFALL_PCT, color: '#dc2626' },
      ];
    }
    if (panel.metric === 'hz' && panel.topics.length === 1) {
      const exp = latestExpected(history, panel.topics[0]!);
      return exp != null ? [{ v: exp, color: '#94a3b8' }] : [];
    }
    return [];
  }, [panel.metric, panel.topics, history]);

  return (
    <Card className="flex flex-col gap-2.5 p-4" data-testid="scope-panel">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="scope metric"
          value={panel.metric}
          onChange={(e) => onUpdate({ metric: e.target.value as ScopeMetric })}
          className="rounded-control border border-gray-200 px-2 py-1 text-sm font-medium text-gray-700 focus:border-teal-500 focus:outline-none"
        >
          {METRIC_OPTIONS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        <select
          aria-label="scope add topic"
          value={addTopic}
          onChange={(e) => setAddTopic(e.target.value)}
          className="min-w-[10rem] rounded-control border border-gray-200 px-2 py-1 text-sm font-medium text-gray-700 focus:border-teal-500 focus:outline-none"
        >
          <option value="">Add topic…</option>
          {available.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={addChip}
          disabled={!addTopic}
          className="rounded-control border border-gray-200 px-2 py-1 text-xs font-medium text-gray-500 hover:bg-gray-50 disabled:opacity-50"
        >
          + Add
        </button>
        <div className="flex-1" />
        <RemovePanelButton onRemove={onRemove} />
      </div>

      {panel.topics.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {panel.topics.map((t, i) => (
            <SeriesChip
              key={t}
              color={PALETTE[i % PALETTE.length]!}
              label={shortTopic(t)}
              title={t}
              onRemove={() => removeChip(t)}
            />
          ))}
        </div>
      )}

      {panel.topics.length === 0 ? (
        <p className="py-6 text-center text-[11.5px] text-gray-400">
          Add a topic to plot its health.
        </p>
      ) : (
        <UplotChart data={data} series={series} markers={markers} refLines={refLines} height={CHART_HEIGHT} />
      )}
    </Card>
  );
}

const RATE_OPTIONS = [1, 5, 10, 30];

function SignalScopePanel({
  panel,
  windowSec,
  markers,
  onUpdate,
  onRemove,
}: {
  panel: ScopeSignalPanel;
  windowSec: number;
  markers: ChartMarker[];
  onUpdate: (patch: ScopePanelPatch) => void;
  onRemove: () => void;
}) {
  const topicsQuery = useProbeTopics();
  const topics = topicsQuery.data ?? [];

  const [addTopic, setAddTopic] = useState<string | null>(null);
  const [addField, setAddField] = useState<string | null>(null);
  const fieldsQuery = useProbeFields(addTopic);
  const fields = fieldsQuery.data?.fields ?? [];
  useEffect(() => {
    if (addField && fields.includes(addField)) return;
    setAddField(fields[0] ?? null);
  }, [fields, addField]);

  const idRef = useRef(0);
  const addSeries = () => {
    if (!addTopic || !addField) return;
    if (panel.series.some((s) => s.topic === addTopic && s.field === addField)) return; // no dupes
    onUpdate({
      series: [
        ...panel.series,
        { id: `sc${panel.id}-${idRef.current++}`, topic: addTopic, field: addField },
      ],
    });
  };
  const removeSeries = (id: string) =>
    onUpdate({ series: panel.series.filter((s) => s.id !== id) });

  // ScopeBand only renders panels while the band is expanded (see ScopeBand.tsx)
  // — a collapsed band unmounts this component entirely, closing its SSE
  // stream(s); re-expanding remounts from the persisted series/hz. So `live` is
  // always true here; useProbeSeries itself no-ops when `series` is empty.
  const { data } = useProbeSeries(panel.series, true, panel.hz, windowSec);
  const series: UplotSeriesConf[] = panel.series.map((s, i) => ({
    label: seriesLabel(s),
    stroke: PALETTE[i % PALETTE.length]!,
  }));

  return (
    <Card className="flex flex-col gap-2.5 p-4" data-testid="scope-panel">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="scope topic"
          value={addTopic ?? ''}
          onChange={(e) => {
            setAddTopic(e.target.value || null);
            setAddField(null);
          }}
          className="min-w-[10rem] rounded-control border border-gray-200 px-2 py-1 text-sm font-medium text-gray-700 focus:border-teal-500 focus:outline-none"
        >
          <option value="">{topicsQuery.isPending ? 'Loading topics…' : 'Select a topic…'}</option>
          {topics.map((t) => (
            <option key={t.name} value={t.name}>
              {t.name}
            </option>
          ))}
        </select>
        <select
          aria-label="scope field"
          value={addField ?? ''}
          disabled={!addTopic || fields.length === 0}
          onChange={(e) => setAddField(e.target.value || null)}
          className="min-w-[9rem] rounded-control border border-gray-200 px-2 py-1 text-sm font-medium text-gray-700 focus:border-teal-500 focus:outline-none disabled:opacity-50"
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
        <button
          type="button"
          onClick={addSeries}
          disabled={!addTopic || !addField}
          className="rounded-control border border-gray-200 px-2 py-1 text-xs font-medium text-gray-500 hover:bg-gray-50 disabled:opacity-50"
        >
          + Add
        </button>
        <label className="flex items-center gap-1.5 text-xs text-gray-500">
          Rate
          <select
            aria-label="scope rate"
            value={panel.hz}
            onChange={(e) => onUpdate({ hz: Number(e.target.value) })}
            className="rounded-control border border-gray-200 px-2 py-1 text-sm font-medium text-gray-700 focus:border-teal-500 focus:outline-none"
          >
            {RATE_OPTIONS.map((h) => (
              <option key={h} value={h}>
                {h} Hz
              </option>
            ))}
          </select>
        </label>
        <div className="flex-1" />
        <RemovePanelButton onRemove={onRemove} />
      </div>

      {panel.series.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {panel.series.map((s, i) => (
            <SeriesChip
              key={s.id}
              color={PALETTE[i % PALETTE.length]!}
              label={seriesLabel(s)}
              title={`${s.topic} · ${s.field}`}
              onRemove={() => removeSeries(s.id)}
            />
          ))}
        </div>
      )}

      {panel.series.length === 0 ? (
        <p className="py-6 text-center text-[11.5px] text-gray-400">
          Add a topic + field to start plotting.
        </p>
      ) : (
        <UplotChart data={data} series={series} markers={markers} height={CHART_HEIGHT} />
      )}
    </Card>
  );
}

export function ScopePanel({
  panel,
  topics,
  history,
  windowSec,
  now,
  markers,
  onUpdate,
  onRemove,
}: {
  panel: ScopePanelState;
  topics: string[];
  history: Map<string, MetricSample[]>;
  windowSec: number;
  now: number;
  markers: ChartMarker[];
  onUpdate: (patch: ScopePanelPatch) => void;
  onRemove: () => void;
}) {
  if (panel.kind === 'health') {
    return (
      <HealthScopePanel
        panel={panel}
        topics={topics}
        history={history}
        windowSec={windowSec}
        now={now}
        markers={markers}
        onUpdate={onUpdate}
        onRemove={onRemove}
      />
    );
  }
  return (
    <SignalScopePanel
      panel={panel}
      windowSec={windowSec}
      markers={markers}
      onUpdate={onUpdate}
      onRemove={onRemove}
    />
  );
}
