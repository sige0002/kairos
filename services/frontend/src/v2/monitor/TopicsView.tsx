// Topics sub-view (the mock's own scope, §11): chart PANELS + topics table on the
// left, Events + System on the right. Restores the v1 Graph tab's add/remove-panel
// model — each panel is one metric × its own overlaid topic set — in the v2 skin.
//
// The rolling metric accumulator, the window-anchor clock, and the REC/STOP marker
// stream are read ONCE here and shared down to every panel (one accumulator, not
// one per chart). The time window (30s/1m/5m) and Pause are GLOBAL across panels
// (v1 semantics) and live in this toolbar; each panel owns only its metric + topic
// set. Panel configs live in a module store so they survive a sub-nav / tab switch.

import { useEffect, useMemo, useState } from 'react';
import type { RuntimeConfig } from '../../config';
import { useMonitorRows } from '../../features/monitor/useMonitorRows';
import { useMetricHistory } from '../../features/graph/useMetricHistory';
import { useUiStore } from '../../store/uiStore';
import { cn } from '../../components/ui';
import { FrequencyChartCard } from './FrequencyChartCard';
import { TopicsTable } from './TopicsTable';
import { EventsCard } from './EventsCard';
import { SystemCard } from './SystemCard';
import { useNowClock } from './useNowClock';
import { useRecMarkers } from './useRecMarkers';
import { MONITOR_WINDOWS, type MonitorWindowId, toggleTopic, windowMs } from './chartSeries';
import { configSeedKey } from '../seedKey';
import {
  MAX_PANELS,
  addPanel,
  removePanel,
  resolvePanelTopics,
  setPanelMetric,
  setPanelTopics,
  usePanels,
} from './panelStore';

/** Coarse "time since Monitor opened" for the honesty note (e.g. `2m`, `45s`). */
function formatElapsed(ms: number): string {
  const secs = Math.floor(ms / 1000);
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m`;
}

export function TopicsView({ config }: { config: RuntimeConfig }) {
  const { rows, isDiscovering, malformedDropped } = useMonitorRows(config);

  // Rec-topic picker (shared uiStore, consumed by a Collect-side /record/start).
  // Mirrors v1 LiveTab: seed the selection from the active robot's configured
  // topics as discovery first arrives, keyed on the robot's default_topics so a
  // robot switch re-seeds (and resets a stale customized set) but a discovery
  // refresh does not clobber an operator's edits.
  const recordSelected = useUiStore((s) => s.recordSelected);
  const seedRecordTopics = useUiStore((s) => s.seedRecordTopics);
  const toggleRecordTopic = useUiStore((s) => s.toggleRecordTopic);
  const seedKey = useMemo(
    () => configSeedKey(config.defaults.default_topics ?? []),
    [config],
  );
  useEffect(() => {
    if (rows.length === 0) return;
    seedRecordTopics(
      rows.filter((r) => r.configured).map((r) => r.name),
      seedKey,
    );
  }, [rows, seedRecordTopics, seedKey]);

  // --- global (cross-panel) chart controls: window + pause -------------------
  const [windowId, setWindowId] = useState<MonitorWindowId>('1m');
  const [paused, setPaused] = useState(false);

  // Shared, single-instance metric accumulation / clock / markers. Pause freezes
  // both the accumulation and the window anchor so the charts truly stop rather
  // than scrolling frozen points off-screen; Resume restarts both.
  const now = useNowClock(!paused);
  const { history, updatedAt } = useMetricHistory(config, paused);
  const markers = useRecMarkers();

  // Honesty (D-8-7): the window is "at most {windowId} since Monitor opened", not a
  // rolling history that predates this session. While the buffer is younger than the
  // selected window, surface how long it has actually been accumulating.
  //
  // Measured on the MONOTONIC clock (E-32): how long this session has been
  // accumulating is a duration on this machine, and the wall clock is not a
  // stopwatch. An NTP step forward made `windowNotFull` false at once and the
  // caveat simply vanished — the screen presenting seconds of buffer as a full
  // window — and a step back pinned it at "(0s so far)".
  //
  // `now` is still what drives this: it is the 1 Hz tick that recomputes the
  // line, and its freeze-on-pause is what freezes this note with the charts.
  // Only the MEASUREMENT moved off it. The chart's own time axis is a separate
  // question and deliberately untouched — samples are stamped with `Date.now()`
  // in useMetricHistory and aged out against the same clock, so making the axis
  // monotonic would change what a sample's timestamp means.
  const [openedAtMono] = useState(() => performance.now());
  const elapsedMs = useMemo(
    () => Math.max(0, performance.now() - openedAtMono),
    [now, openedAtMono],
  );
  const windowNotFull = elapsedMs < windowMs(windowId);

  // --- panels ---------------------------------------------------------------
  const panels = usePanels();
  const availableNames = useMemo(() => rows.map((r) => r.name), [rows]);

  // Layout: one column for a single panel, two columns beyond that; panels share
  // the left column's height (auto-rows-fr) and the chart height shrinks with the
  // row count so the whole thing fits without page scroll.
  const cols = panels.length >= 2 ? 2 : 1;
  const rowCount = Math.ceil(panels.length / cols);
  // Shrink the chart as rows stack so the panels + table fit without page scroll;
  // a single row of panels gets a taller chart to use the column's full height.
  const chartHeight = rowCount >= 2 ? 150 : 360;
  const layoutKey = `${cols}x${rowCount}`;

  // The primary panel (index 0) is driven by the TopicsTable row clicks — its
  // untouched state auto-tracks the first discovered topic (unchanged v2 UX).
  const primary = panels[0]!;
  const primaryTopics = useMemo(
    () => resolvePanelTopics(primary?.topics ?? null, true, availableNames),
    [primary, availableNames],
  );
  const onTableToggle = (name: string) => {
    const base = primary.topics ?? (rows[0] ? [rows[0].name] : []);
    setPanelTopics(primary.id, toggleTopic(base, name));
  };

  return (
    <div className="grid flex-1 grid-cols-1 gap-2.5 lg:min-h-0 lg:grid-cols-[1fr_340px]">
      <div className="flex flex-col gap-2.5 lg:min-h-0">
        {/* uPlot's built-in bottom legend is scoped away for every panel here (one
            rule, not one <style> per card) — see FrequencyChartCard. */}
        <style>{'.monitor-freq-chart .u-legend { display: none; }'}</style>

        <div className="flex shrink-0 flex-wrap items-center gap-2.5">
          <span
            className="font-mono text-[11.5px] text-gray-400"
            title="History accumulates from when Monitor opened."
          >
            {rows.length} topics · {panels.length} chart{panels.length === 1 ? '' : 's'} · {windowId}{' '}
            window{windowNotFull ? ` (${formatElapsed(elapsedMs)} so far)` : ''}
          </span>
          {paused && (
            <span data-testid="freeze-note" className="font-mono text-[11px] text-amber-600">
              Charts frozen · table still live.
            </span>
          )}
          {/* The SSE ingest drops readings it cannot identify rather than
              letting one take the console down (E-23, sse/useEventStream).
              Dropping is the right call — a row with no usable name cannot be
              keyed or named — but a monitoring table quietly showing fewer
              topics than the robot published would be lying by omission, so
              the count is stated rather than swallowed. */}
          {malformedDropped > 0 && (
            <span
              data-testid="malformed-note"
              title="These readings arrived in a shape this screen could not read — no usable topic name — so they were left out rather than shown under an invented one."
              className="font-mono text-[11px] text-amber-600"
            >
              {malformedDropped} reading{malformedDropped === 1 ? '' : 's'} ignored
              (unreadable)
            </span>
          )}
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
            title="Freezes the charts only — the topics table keeps updating live."
            onClick={() => setPaused((p) => !p)}
            className={cn(
              'rounded-control border px-3 py-1 text-[11px] font-medium transition-colors',
              paused
                ? 'border-amber-200 bg-amber-50 text-amber-700'
                : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50',
            )}
          >
            {paused ? 'Live' : 'Freeze charts'}
          </button>
          <button
            type="button"
            data-testid="add-chart"
            onClick={() => addPanel(availableNames[0])}
            disabled={panels.length >= MAX_PANELS}
            className="rounded-control bg-teal-600 px-3 py-1 text-[11px] font-semibold text-white shadow-card transition-colors hover:bg-teal-700 disabled:bg-gray-300"
          >
            + Add chart
          </button>
        </div>

        <div
          data-testid="chart-panels"
          className={cn(
            'grid min-h-0 flex-1 auto-rows-fr gap-2.5 overflow-hidden',
            cols === 2 ? 'grid-cols-2' : 'grid-cols-1',
          )}
        >
          {panels.map((panel, i) => {
            const isPrimary = i === 0;
            const topics = isPrimary
              ? primaryTopics
              : resolvePanelTopics(panel.topics, false, availableNames);
            return (
              <FrequencyChartCard
                key={panel.id}
                panel={panel}
                isPrimary={isPrimary}
                rows={rows}
                topics={topics}
                windowId={windowId}
                history={history}
                updatedAt={updatedAt}
                now={now}
                markers={markers}
                chartHeight={chartHeight}
                layoutKey={layoutKey}
                removable={!isPrimary}
                onMetricChange={(m) => setPanelMetric(panel.id, m)}
                onToggleTopic={(name) =>
                  setPanelTopics(panel.id, toggleTopic(panel.topics ?? [], name))
                }
                onRemove={() => removePanel(panel.id)}
              />
            );
          })}
        </div>

        <TopicsTable
          rows={rows}
          isDiscovering={isDiscovering}
          chartedTopics={primaryTopics}
          onToggle={onTableToggle}
          recordSelected={recordSelected}
          onToggleRec={toggleRecordTopic}
        />
      </div>
      <div className="flex flex-col gap-2.5 lg:min-h-0">
        <EventsCard />
        <SystemCard />
      </div>
    </div>
  );
}
