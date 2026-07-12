// Monitor tab (v2 IA) — absorbs the old Graph + Probe tabs (Topics / Signals /
// Events / System sub-views) plus the header's old SystemInfo footer. Only
// Topics has a built-out layout (the mock's own scope, §11); the rest render a
// shared placeholder. The context strip's Episode/time-range/warning-chip are
// static mock — the handoff from Collect needs a Session/Batch/Episode model
// that's Phase 2 (see mockData.ts).

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchRuntimeConfig } from '../../config';
import { queryKeys } from '../../api/queryKeys';
import { useUiStore } from '../../store/uiStore';
import { Card, cn } from '../../components/ui';
import { TopicsView } from './TopicsView';
import { OtherView } from './OtherView';
import { MONITOR_CONTEXT } from './mockData';

const MON_NAV = ['Overview', 'Topics', 'Signals', 'System', 'Events', 'Logs'] as const;
type MonView = (typeof MON_NAV)[number];

export function MonitorScreen() {
  // Seeded by the app shell before any tab renders (see CollectScreen) — reads
  // the same cache instead of threading a `config` prop down from App.tsx.
  const { data: config } = useQuery({
    queryKey: queryKeys.runtimeConfig,
    queryFn: fetchRuntimeConfig,
  });
  const setActiveTab = useUiStore((s) => s.setActiveTab);
  const [monView, setMonView] = useState<MonView>('Topics');

  return (
    <div className="flex flex-col gap-2.5 lg:h-full lg:min-h-0">
      <div className="flex shrink-0 flex-wrap items-center gap-2.5">
        <Card className="flex items-center gap-2.5 px-3.5 py-2">
          <span className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-gray-400">
            Context
          </span>
          <span className="font-mono text-[12.5px] font-semibold text-gray-900">
            {MONITOR_CONTEXT.episode}
          </span>
          <span className="font-mono text-xs text-gray-500">{MONITOR_CONTEXT.timeRange}</span>
          <span className="inline-flex rounded-chip bg-amber-100 px-[7px] py-0.5 text-[10.5px] font-bold text-amber-800">
            {MONITOR_CONTEXT.chip}
          </span>
        </Card>

        <div className="flex gap-0.5 rounded-[11px] border border-gray-200 bg-gray-100 p-[3px]">
          {MON_NAV.map((label) => (
            <button
              key={label}
              type="button"
              data-testid={`mon-nav-${label}`}
              onClick={() => setMonView(label)}
              className={cn(
                'rounded-lg px-3.5 py-1.5 text-[12.5px] font-medium transition-colors',
                label === monView
                  ? 'bg-teal-600 font-semibold text-white'
                  : 'text-gray-500 hover:text-gray-700',
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

      {monView === 'Topics' ? (
        config ? (
          <TopicsView config={config} />
        ) : (
          <div className="p-4 text-sm text-gray-400">Loading…</div>
        )
      ) : (
        <OtherView label={monView} onBack={() => setMonView('Topics')} />
      )}
    </div>
  );
}
