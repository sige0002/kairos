import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { setApiBase } from './api/client';
import {
  fetchRuntimeConfig,
  orderTabs,
  type RuntimeConfig,
  type TabConfig,
} from './config';
import { queryKeys } from './api/queryKeys';
import { useEventStream } from './sse/useEventStream';
import { useUiStore } from './store/uiStore';
import { RecordTab } from './features/record/RecordTab';
import { MonitorTab } from './features/monitor/MonitorTab';
import { StreamTab } from './features/stream/StreamTab';
import { RunsTab } from './features/runs/RunsTab';
import { PipelinesTab } from './features/pipelines/PipelinesTab';
import { ConfigTab } from './features/config/ConfigTab';

// Human-readable labels for the registry-driven tabs. The set of tabs and
// their enabled state come from the backend (GET /api/v1/config); this only
// supplies default display names when the backend omits a label.
const TAB_LABELS: Record<string, string> = {
  record: 'Record',
  monitor: 'Monitor',
  stream: 'Stream',
  runs: 'Runs',
  pipelines: 'Pipelines',
  config: 'Config',
};

function tabLabel(tab: TabConfig): string {
  return tab.label ?? TAB_LABELS[tab.id] ?? tab.id;
}

/** Render the feature component for a given tab id. */
function TabContent({ tabId, config }: { tabId: string; config: RuntimeConfig }) {
  switch (tabId) {
    case 'record':
      return <RecordTab config={config} />;
    case 'monitor':
      return <MonitorTab config={config} />;
    case 'stream':
      return <StreamTab config={config} />;
    case 'runs':
      return <RunsTab />;
    case 'pipelines':
      return <PipelinesTab config={config} />;
    case 'config':
      return <ConfigTab />;
    default:
      return <p className="text-sm text-gray-500">Unknown tab: {tabId}</p>;
  }
}

function Tabs({ config }: { config: RuntimeConfig }) {
  const ordered = orderTabs(config.tabs);
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
    <div>
      <nav role="tablist" aria-label="kairos tabs" className="flex gap-2 border-b">
        {ordered.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={tab.id === active}
            disabled={!tab.enabled}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2 disabled:opacity-40 ${
              tab.id === active ? 'border-b-2 border-blue-600 font-medium' : ''
            }`}
          >
            {tabLabel(tab)}
          </button>
        ))}
      </nav>
      <section role="tabpanel" aria-label={active} className="p-4">
        {active ? (
          <TabContent tabId={active} config={config} />
        ) : (
          <p className="text-sm text-gray-500">No tabs enabled.</p>
        )}
      </section>
    </div>
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
    return <main className="p-4">Loading kairos…</main>;
  }
  if (isError) {
    return (
      <main className="p-4 text-red-700">
        Failed to load configuration: {String(error)}
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-6xl p-4">
      <EventStreamMount url={config.endpoints.events} />
      <h1 className="mb-4 text-xl font-semibold">kairos</h1>
      <Tabs config={config} />
    </main>
  );
}
