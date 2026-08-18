// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Monitor tab (v2 IA) — absorbs the old Graph + Probe tabs plus the header's old
// SystemInfo footer. All six §11 sub-views are built out on real data:
//   Overview  — diagnostic landing (record context, topic-health tally, incidents)
//   Topics    — the add-panel chart grid + topics table (the mock's own scope)
//   Signals   — the ported topic_probe numeric-field plotter
//   System    — host facts + utilization + endpoints + honest component health
//   Store     — the catalog's opinion of itself: SUSPECT, corrupt sidecars,
//               rebuild findings and the Repair action (contract §8 / §9-3)
//   Events    — full-page incident view over the real alert buffer
//   Logs      — session-local timeline of received SSE lifecycle events
// The context strip shows the REAL recording state (RecordContextChip).

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchRuntimeConfig } from '../../config';
import { queryKeys } from '../../api/queryKeys';
import { useUiStore } from '../../store/uiStore';
import { cn } from '../../components/ui';
import { TopicsView } from './TopicsView';
import { OverviewView } from './OverviewView';
import { SystemView } from './SystemView';
import { StoreHealthView } from './StoreHealthView';
import { EventsView } from './EventsView';
import { LogsView } from './LogsView';
import { RecordContextChip } from './RecordContextChip';
import { SignalsView } from './signals/SignalsView';
import { setPanelTopics, usePanels } from './panelStore';
import { ScreenTitle } from '../shared/ScreenTitle';

const MON_NAV = [
  'Overview',
  'Topics',
  'Signals',
  'System',
  'Store',
  'Events',
  'Logs',
] as const;
type MonView = (typeof MON_NAV)[number];

function routeMonView(): MonView {
  return new URLSearchParams(window.location.search).get('view') === 'store'
    ? 'Store'
    : 'Overview';
}

function writeMonView(view: MonView): void {
  const params = new URLSearchParams(window.location.search);
  if (view === 'Store') params.set('view', 'store');
  else params.delete('view');
  window.history.replaceState(null, '', `${window.location.pathname}?${params}`);
}

export function MonitorScreen() {
  // Seeded by the app shell before any tab renders (see CollectScreen) — reads
  // the same cache instead of threading a `config` prop down from App.tsx.
  const { data: config } = useQuery({
    queryKey: queryKeys.runtimeConfig,
    queryFn: fetchRuntimeConfig,
  });
  const setActiveTab = useUiStore((s) => s.setActiveTab);
  // Overview is the diagnostic landing (§11 order); the operator drills into the
  // other sub-views from there.
  // Store health is the one Monitor sub-view reached from a global warning, so
  // it is addressable and survives a reload/pop-out. Other sub-views remain
  // local navigation; making only this safety-relevant destination routable
  // avoids turning incidental chart state into a second router.
  const [monView, setMonView] = useState<MonView>(routeMonView);
  const selectMonView = (view: MonView) => {
    setMonView(view);
    writeMonView(view);
  };

  // The Topics view's primary chart panel (index 0) is what Overview's "chart →"
  // links target: set its topic set, then switch to Topics so the click lands on
  // that topic already plotted.
  const panels = usePanels();
  const openTopics = (topic?: string) => {
    if (topic && panels[0]) setPanelTopics(panels[0].id, [topic]);
    selectMonView('Topics');
  };

  return (
    <div className="flex flex-col gap-2.5 lg:h-full lg:min-h-0">
      <ScreenTitle>Monitor</ScreenTitle>
      <div className="flex shrink-0 flex-wrap items-center gap-2.5">
        <RecordContextChip />

        <div className="flex flex-wrap gap-0.5 rounded-[11px] border border-gray-200 bg-gray-100 p-[3px]">
          {MON_NAV.map((label) => (
            <button
              key={label}
              type="button"
              data-testid={`mon-nav-${label}`}
              aria-pressed={label === monView}
              onClick={() => selectMonView(label)}
              className={cn(
                'rounded-lg px-3.5 py-1.5 text-[12.5px] font-medium transition-colors',
                label === monView
                  ? 'bg-teal-700 font-semibold text-white'
                  : 'text-gray-600 hover:text-gray-700',
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setActiveTab('collect')}
          className="text-[12.5px] font-semibold text-gray-700 hover:text-teal-700"
        >
          ← Back to Collect
        </button>
      </div>

      {!config ? (
        <div className="p-4 text-sm text-gray-500">Loading…</div>
      ) : monView === 'Overview' ? (
        <OverviewView
          config={config}
          onOpenTopics={openTopics}
          onOpenSignals={() => selectMonView('Signals')}
        />
      ) : monView === 'Topics' ? (
        <TopicsView config={config} />
      ) : monView === 'Signals' ? (
        <SignalsView />
      ) : monView === 'System' ? (
        <SystemView config={config} />
      ) : monView === 'Store' ? (
        <StoreHealthView />
      ) : monView === 'Events' ? (
        <EventsView />
      ) : (
        <LogsView />
      )}
    </div>
  );
}
