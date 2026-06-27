import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { setApiBase } from './api/client';
import {
  ensureClientTabs,
  fetchRuntimeConfig,
  orderTabs,
  type RuntimeConfig,
  type TabConfig,
} from './config';
import { queryKeys } from './api/queryKeys';
import { useEventStream } from './sse/useEventStream';
import { useUiStore } from './store/uiStore';
import { LiveTab } from './features/live/LiveTab';
import { GraphTab } from './features/graph/GraphTab';
import { ProbeTab } from './features/probe/ProbeTab';
import { RunsTab } from './features/runs/RunsTab';
import { ValidationTab } from './features/validation/ValidationTab';
import { DatasetTab } from './features/dataset/DatasetTab';
import { ConfigTab } from './features/config/ConfigTab';
import { SystemInfo } from './features/system/SystemInfo';
import { Hexagon, StatusDot, cn } from './components/ui';
import type { SseStatus } from './store/uiStore';

// Human-readable labels for the registry-driven tabs. The set of tabs and
// their enabled state come from the backend (GET /api/v1/config); this only
// supplies default display names when the backend omits a label. The design
// handoff IA: Live / Graph / Recordings / Validation / Datasets / Config.
// `runs` stays the internal tab id (backend contract); the label is the
// operator-facing "Recordings" (the browsable history of recordings).
const TAB_LABELS: Record<string, string> = {
  live: 'Live',
  graph: 'Graph',
  probe: 'Probe',
  runs: 'Recordings',
  validation: 'Validation',
  dataset: 'Datasets',
  config: 'Config',
};

function tabLabel(tab: TabConfig): string {
  return tab.label ?? TAB_LABELS[tab.id] ?? tab.id;
}

/** Render the feature component for a given tab id. */
function TabContent({ tabId, config }: { tabId: string; config: RuntimeConfig }) {
  switch (tabId) {
    case 'live':
      return <LiveTab config={config} />;
    case 'graph':
      return <GraphTab config={config} />;
    case 'probe':
      return <ProbeTab />;
    case 'runs':
      return <RunsTab />;
    case 'validation':
      return <ValidationTab />;
    case 'dataset':
      return <DatasetTab />;
    case 'config':
      return <ConfigTab config={config} />;
    default:
      return <p className="text-sm text-gray-500">Unknown tab: {tabId}</p>;
  }
}

function Tabs({ config }: { config: RuntimeConfig }) {
  // ensureClientTabs injects frontend-only tabs (e.g. Probe / OL-3.3) that the
  // backend config may not list yet; backend-provided tabs always win by id.
  const ordered = orderTabs(ensureClientTabs(config.tabs));
  const enabled = ordered.filter((t) => t.enabled);
  const activeTab = useUiStore((s) => s.activeTab);
  const setActiveTab = useUiStore((s) => s.setActiveTab);

  // Default the active tab to the first enabled one, once config is known.
  useEffect(() => {
    if (!activeTab && enabled[0]) setActiveTab(enabled[0].id);
    // If the active tab got disabled by a config change, fall back.
    else if (activeTab && !enabled.some((t) => t.id === activeTab) && enabled[0]) {
      setActiveTab(enabled[0].id);
    }
  }, [activeTab, enabled, setActiveTab]);

  const active = activeTab || enabled[0]?.id || '';

  return (
    <div className="flex flex-col gap-3">
      <nav
        role="tablist"
        aria-label="kairos tabs"
        className="flex flex-wrap gap-[3px] self-start rounded-[12px] border border-gray-200 bg-gray-100 p-1"
      >
        {ordered.map((tab) => {
          const on = tab.id === active;
          return (
            <button
              key={tab.id}
              id={`tab-${tab.id}`}
              role="tab"
              aria-selected={on}
              aria-controls={`panel-${tab.id}`}
              disabled={!tab.enabled}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                'rounded-[9px] px-4 py-2 text-[13.5px] transition-colors disabled:opacity-40',
                on
                  ? 'bg-teal-600 font-semibold text-white shadow-sm'
                  : 'font-medium text-gray-500 hover:text-gray-700',
              )}
            >
              {tabLabel(tab)}
            </button>
          );
        })}
      </nav>
      <section
        role="tabpanel"
        id={active ? `panel-${active}` : undefined}
        aria-labelledby={active ? `tab-${active}` : undefined}
      >
        {active ? (
          <TabContent tabId={active} config={config} />
        ) : (
          <p className="text-sm text-gray-500">No tabs enabled.</p>
        )}
      </section>
    </div>
  );
}

/** Live DDS/SSE connection chip in the header (driven by the SSE status). */
function ConnectionBadge() {
  const status = useUiStore((s) => s.sseStatus);
  const tone: Record<SseStatus, 'green' | 'amber' | 'gray'> = {
    open: 'green',
    connecting: 'amber',
    reconnecting: 'amber',
    closed: 'gray',
  };
  const label: Record<SseStatus, string> = {
    open: 'DDS connected',
    connecting: 'connecting',
    reconnecting: 'reconnecting',
    closed: 'disconnected',
  };
  const live = status === 'open';
  return (
    <span
      data-testid="connection-status"
      className={cn(
        'inline-flex items-center gap-2 rounded-control border px-3 py-2',
        live ? 'border-teal-200 bg-teal-100' : 'border-gray-200 bg-white',
      )}
    >
      <StatusDot tone={tone[status]} />
      <span
        className={cn(
          'font-mono text-[12.5px] font-semibold',
          live ? 'text-teal-700' : 'text-gray-600',
        )}
      >
        {label[status]}
      </span>
    </span>
  );
}

/**
 * Active ROS 2 domain id, shown as a small mono chip next to the connection
 * badge (operator context). Hidden when the backend omits it.
 */
function DomainChip({ domainId }: { domainId?: number }) {
  if (domainId === undefined) return null;
  return (
    <span
      data-testid="ros-domain"
      title={`ROS 2 domain ${domainId} (ROS_DOMAIN_ID)`}
      className="inline-flex items-center gap-1.5 rounded-control border border-gray-200 bg-white px-3 py-2 font-mono text-[12.5px] font-semibold text-gray-600"
    >
      <span className="uppercase tracking-[0.04em] text-gray-400">DOMAIN</span>
      {domainId}
    </span>
  );
}

/** Mounts the single SSE subscription for the app's lifetime. */
function EventStreamMount({ url }: { url: string }) {
  useEventStream(url);
  return null;
}

export function App() {
  // Render gate: wait for the backend config before showing the UI. config.ts
  // provides a dev-only fallback so the SPA renders without a backend.
  const {
    data: config,
    isPending,
    isError,
    error,
  } = useQuery({ queryKey: queryKeys.runtimeConfig, queryFn: fetchRuntimeConfig });

  // Point the REST client at the configured base as soon as we have config.
  useEffect(() => {
    if (config) setApiBase(config.endpoints.api);
  }, [config]);

  if (isPending) {
    return (
      <main className="flex min-h-screen items-center gap-3 bg-gray-50 p-[22px] text-gray-500">
        <Hexagon size={22} />
        Loading kairos…
      </main>
    );
  }
  if (isError) {
    return (
      <main className="min-h-screen bg-gray-50 p-[22px] text-red-700">
        Failed to load configuration: {String(error)}
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gray-50 px-[22px] pb-[22px] pt-2.5">
      <EventStreamMount url={config.endpoints.events} />
      <header className="mb-2.5 flex flex-wrap items-center gap-4">
        <a
          href="/"
          aria-label="kairos — recording console (home)"
          title="kairos — recording console (home)"
          className="flex items-center gap-[11px] rounded-control focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
        >
          <Hexagon />
          <span className="text-[21px] font-bold tracking-[-0.02em] text-gray-900">
            kairos
          </span>
        </a>
        <div className="flex-1" />
        <div className="flex flex-col items-end gap-1.5">
          <div className="flex flex-wrap items-center justify-end gap-3">
            <DomainChip domainId={config.defaults.ros_domain_id} />
            <ConnectionBadge />
          </div>
          <SystemInfo className="justify-end pr-1" />
        </div>
        <div
          aria-label="kairos brand mark"
          title="kairos — recording console"
          className="flex h-[34px] w-[34px] items-center justify-center rounded-full border border-gray-200 bg-gray-100 text-[13px] font-semibold text-gray-600"
        >
          K
        </div>
      </header>
      <Tabs config={config} />
    </main>
  );
}
