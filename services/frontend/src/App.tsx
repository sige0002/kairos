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

// ---- per-tab pages (deep link + pop-out) ------------------------------------
// Each tab is addressable by URL (`?tab=<id>`); `?tab=<id>&solo=1` renders ONLY
// that tab as a standalone page (no tab nav) so it can live in its own browser
// window. Low-friction: a ↗ button per tab opens its solo page in a new window.
// State-based (no router dependency) — we read/sync window.location directly.
function readRoute(): { tab: string | null; solo: boolean } {
  const p = new URLSearchParams(window.location.search);
  return { tab: p.get('tab'), solo: p.get('solo') === '1' };
}

function tabUrl(id: string, solo: boolean): string {
  const p = new URLSearchParams(window.location.search);
  p.set('tab', id);
  if (solo) p.set('solo', '1');
  else p.delete('solo');
  return `${window.location.pathname}?${p.toString()}`;
}

function openTabWindow(id: string): void {
  window.open(tabUrl(id, true), '_blank', 'noopener,noreferrer');
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

  // Default the active tab: prefer a deep-linked `?tab=<id>` (if enabled), else
  // the first enabled tab, once config is known. Also fall back if the active
  // tab got disabled by a config change.
  useEffect(() => {
    if (!activeTab) {
      const { tab } = readRoute();
      if (tab && enabled.some((t) => t.id === tab)) setActiveTab(tab);
      else if (enabled[0]) setActiveTab(enabled[0].id);
    } else if (!enabled.some((t) => t.id === activeTab) && enabled[0]) {
      setActiveTab(enabled[0].id);
    }
  }, [activeTab, enabled, setActiveTab]);

  const active = activeTab || enabled[0]?.id || '';

  // Reflect the active tab in the URL (`?tab=<id>`) so a refresh keeps the tab
  // and the pop-out/deep-link stays accurate. replaceState — no history spam.
  useEffect(() => {
    if (!active) return;
    const p = new URLSearchParams(window.location.search);
    if (p.get('tab') !== active || p.has('solo')) {
      p.set('tab', active);
      p.delete('solo');
      window.history.replaceState(null, '', `${window.location.pathname}?${p.toString()}`);
    }
  }, [active]);

  const activeTabConfig = ordered.find((t) => t.id === active);
  return (
    <div className="flex flex-col gap-3 lg:min-h-0 lg:flex-1">
      <div className="flex flex-wrap items-center gap-2 lg:shrink-0">
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
        {/* Pop-out the current tab into its own window (?tab=<id>&solo=1). Kept
            OUTSIDE the tablist so assistive tech sees only tabs there. Any tab is
            also directly addressable by its deep-link URL. */}
        {active && (
          <button
            type="button"
            aria-label={`open ${activeTabConfig ? tabLabel(activeTabConfig) : active} in a new window`}
            title="Open the current tab in its own window"
            onClick={() => openTabWindow(active)}
            className="inline-flex items-center gap-1 rounded-control border border-gray-200 px-2.5 py-1.5 text-[12.5px] text-gray-500 transition-colors hover:bg-white hover:text-teal-700"
          >
            ↗<span className="hidden sm:inline">Open in new window</span>
          </button>
        )}
      </div>
      <section
        role="tabpanel"
        id={active ? `panel-${active}` : undefined}
        aria-labelledby={active ? `tab-${active}` : undefined}
        className="lg:min-h-0 lg:flex-1 lg:overflow-auto"
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

/** Live DDS/SSE connection chip in the header.
 *
 * Two signals combine: the SSE pipe to the (local) orchestrator, and the
 * orchestrator's own bridge to the monitor — which runs ON the robot in the
 * cross-host split. A green "DDS connected" therefore requires BOTH; an open
 * pipe with the bridge down reads "robot offline" instead of a false green. */
function ConnectionBadge() {
  const status = useUiStore((s) => s.sseStatus);
  const bridge = useUiStore((s) => s.monitorBridge);
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
  const robotOffline = status === 'open' && bridge === 'down';
  const live = status === 'open' && !robotOffline;
  return (
    <span
      data-testid="connection-status"
      title={
        robotOffline
          ? 'The orchestrator is up, but the monitor (robot-edge) is unreachable — check the robot / ROBOT_IP.'
          : undefined
      }
      className={cn(
        'inline-flex items-center gap-2 rounded-control border px-3 py-2',
        live
          ? 'border-teal-200 bg-teal-100'
          : robotOffline
            ? 'border-amber-200 bg-amber-50'
            : 'border-gray-200 bg-white',
      )}
    >
      <StatusDot tone={robotOffline ? 'amber' : tone[status]} />
      <span
        className={cn(
          'font-mono text-[12.5px] font-semibold',
          live ? 'text-teal-700' : robotOffline ? 'text-amber-700' : 'text-gray-600',
        )}
      >
        {robotOffline ? 'robot offline' : label[status]}
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

/**
 * Standalone single-tab page (`?tab=<id>&solo=1`): renders ONLY that tab, no tab
 * nav — so an operator can keep e.g. the Live screen in its own window. It runs
 * its own SSE subscription (separate document) and links back to the console.
 */
function SoloPage({ tabId, config }: { tabId: string; config: RuntimeConfig }) {
  const ordered = orderTabs(ensureClientTabs(config.tabs));
  const tab = ordered.find((t) => t.id === tabId);
  const label = tab ? tabLabel(tab) : tabId;
  return (
    <main className="flex h-screen flex-col bg-gray-50 px-[22px] pb-[22px] pt-2.5">
      <EventStreamMount url={config.endpoints.events} />
      <header className="mb-2 flex flex-wrap items-center gap-3">
        <a
          href={tabUrl(tabId, false)}
          title="Back to the kairos console"
          className="flex items-center gap-2 rounded-control text-gray-600 hover:text-teal-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
        >
          <Hexagon size={20} />
          <span className="text-[15px] font-bold tracking-[-0.02em] text-gray-900">kairos</span>
          <span className="text-gray-300">/</span>
          <span className="text-[14px] font-semibold">{label}</span>
        </a>
        <div className="flex-1" />
        <DomainChip domainId={config.defaults.ros_domain_id} />
        <ConnectionBadge />
      </header>
      <section role="tabpanel" aria-label={label} className="min-h-0 flex-1 overflow-auto">
        <TabContent tabId={tabId} config={config} />
      </section>
    </main>
  );
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

  // Standalone single-tab page (`?tab=<id>&solo=1`) — render just that tab.
  const route = readRoute();
  if (route.solo && route.tab) {
    const ordered = orderTabs(ensureClientTabs(config.tabs));
    const valid = ordered.find((t) => t.id === route.tab && t.enabled);
    if (valid) return <SoloPage tabId={valid.id} config={config} />;
  }

  return (
    <main className="min-h-screen bg-gray-50 px-[22px] pb-[22px] pt-2.5 lg:flex lg:h-svh lg:min-h-0 lg:flex-col lg:overflow-hidden">
      <EventStreamMount url={config.endpoints.events} />
      <header className="mb-2.5 flex flex-wrap items-center gap-4 lg:shrink-0">
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
