import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { setApiBase } from './api/client';
import { fetchRuntimeConfig, type RuntimeConfig } from './config';
import { queryKeys } from './api/queryKeys';
import { useEventStream } from './sse/useEventStream';
import { useUiStore } from './store/uiStore';
import { useOperators } from './v2/plans';
import { CollectScreen } from './v2/collect/CollectScreen';
import { ReviewScreen } from './v2/review/ReviewScreen';
import { DatasetsScreen } from './v2/datasets/DatasetsScreen';
import { ValidationScreen } from './v2/validation/ValidationScreen';
import { MonitorScreen } from './v2/monitor/MonitorScreen';
import { SettingsScreen } from './v2/settings/SettingsScreen';
import { resolveTabId, tabLabel, V2_TABS, type V2TabId } from './v2/tabs';
import { useOnPopState } from './v2/shared/useOnPopState';
import { PanelBoundary } from './components/ErrorBoundary';
import { Hexagon, StatusDot, cn } from './components/ui';
import type { SseStatus } from './store/uiStore';

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

/** Render the screen for a given v2 tab id. */
function TabContent({ tabId }: { tabId: V2TabId }) {
  switch (tabId) {
    case 'collect':
      return <CollectScreen />;
    case 'review':
      return <ReviewScreen />;
    case 'datasets':
      return <DatasetsScreen />;
    case 'validation':
      return <ValidationScreen />;
    case 'monitor':
      return <MonitorScreen />;
    case 'settings':
      return <SettingsScreen />;
    default:
      return <p className="text-sm text-gray-500">Unknown tab: {tabId}</p>;
  }
}

/**
 * Resolves the active v2 tab from the store, seeding it from the URL on first
 * mount (applying legacy-id redirects — see `resolveTabId`) and keeping the
 * URL's `?tab=` in sync with it afterwards. `replaceState` — no history spam,
 * and it doubles as the mechanism that rewrites a legacy deep link in place.
 */
function useActiveTab(): V2TabId {
  const activeTab = useUiStore((s) => s.activeTab);
  const setActiveTab = useUiStore((s) => s.setActiveTab);

  useEffect(() => {
    if (!activeTab) setActiveTab(resolveTabId(readRoute().tab));
  }, [activeTab, setActiveTab]);

  // Without this the store would keep its own tab, the mirror effect below
  // would rewrite the restored URL back to it, and the navigation would vanish
  // — the console showing one tab while its own URL named another. A URL naming
  // no tab resolves to the default for exactly that reason. (See useOnPopState
  // for why every mirrored screen needs one of these.)
  useOnPopState(() => setActiveTab(resolveTabId(readRoute().tab)));

  const active = resolveTabId(activeTab || null);

  useEffect(() => {
    // Skip until the seed effect above has resolved the real tab from the URL
    // — otherwise this would briefly overwrite `?tab=` with the pre-seed
    // default (DEFAULT_TAB) on every load, then immediately correct it.
    if (!activeTab) return;
    const p = new URLSearchParams(window.location.search);
    if (p.get('tab') !== active || p.has('solo')) {
      p.set('tab', active);
      p.delete('solo');
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}?${p.toString()}`,
      );
    }
  }, [active, activeTab]);

  return active;
}

/** The 6-tab pill nav (Collect / Review / Datasets / Validation / Monitor /
 *  Settings). Fixed client-side — see `./v2/tabs.ts` for why this no longer
 *  reads the backend's tab registry. */
function TabNav({ active }: { active: V2TabId }) {
  const setActiveTab = useUiStore((s) => s.setActiveTab);
  return (
    <nav
      role="tablist"
      aria-label="kairos tabs"
      className="flex flex-wrap gap-[3px] rounded-[12px] border border-gray-200 bg-gray-100 p-1"
    >
      {V2_TABS.map((tab) => {
        const on = tab.id === active;
        return (
          <button
            key={tab.id}
            id={`tab-${tab.id}`}
            role="tab"
            aria-selected={on}
            aria-controls={`panel-${tab.id}`}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              'rounded-[9px] px-[18px] py-2 text-[13.5px] transition-colors',
              on
                ? 'bg-teal-700 font-semibold text-white shadow-sm'
                : 'font-medium text-gray-600 hover:text-gray-800',
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </nav>
  );
}

/** The active panel plus its pop-out control. Kept as its own row (outside the
 *  tablist) so assistive tech sees only tabs in the nav; the pop-out is still
 *  reachable and every tab remains directly addressable by its deep-link URL. */
function TabPanel({ active }: { active: V2TabId }) {
  return (
    <div className="flex flex-col gap-2 lg:min-h-0 lg:flex-1">
      <div className="flex justify-end lg:shrink-0">
        <button
          type="button"
          aria-label={`open ${tabLabel(active)} in a new window`}
          title="Open the current tab in its own window"
          onClick={() => openTabWindow(active)}
          className="inline-flex items-center gap-1 rounded-control border border-gray-200 px-2.5 py-1.5 text-[12.5px] text-gray-500 transition-colors hover:bg-white hover:text-teal-700"
        >
          ↗<span className="hidden sm:inline">Open in new window</span>
        </button>
      </div>
      <section
        role="tabpanel"
        id={`panel-${active}`}
        aria-labelledby={`tab-${active}`}
        className="lg:min-h-0 lg:flex-1 lg:overflow-auto"
      >
        {/* Scoped so a screen that throws costs the screen, not the console.
            The root boundary is still there as the last resort, but it takes
            the tab bar with it — and the tab bar is how an operator leaves a
            broken panel (E-23). `resetKey` clears this one on the way out. */}
        <PanelBoundary resetKey={active}>
          <TabContent tabId={active} />
        </PanelBoundary>
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
    reconnecting: 'DDS reconnecting…',
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
      <StatusDot tone={robotOffline ? 'amber' : tone[status]} pulse={live} />
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
      <span className="uppercase tracking-[0.04em] text-gray-500">DOMAIN</span>
      {domainId}
    </span>
  );
}

/** Mounts the single SSE subscription for the app's lifetime. */
function EventStreamMount({ url }: { url: string }) {
  useEventStream(url);
  return null;
}

const OPERATOR_STORAGE_KEY = 'kairos.operator';

/** Operator identity chip (v1's Live operator input, relocated): click to set
 *  the name recorded with each episode. Writes the SAME uiStore field the
 *  record-start flow reads (`recordOperator` → /record/start `operator`), plus
 *  localStorage so the name survives a reload — the store itself is in-memory. */
function OperatorChip() {
  const operator = useUiStore((s) => s.recordOperator);
  const setOperator = useUiStore((s) => s.setRecordOperator);
  // Attribution roster (Settings > Operators). Non-empty → the popover is a
  // PICKER (no free text: that is how "yuki"/"Yuki"/"yuki_2" get into labels);
  // empty → the pre-roster free-text input stands and nothing is gated.
  const roster = useOperators();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');

  // Mount-only hydrate from localStorage (never overwrite a live edit). Storage
  // access can THROW rather than return null (private mode, or site data blocked
  // by policy) — and this runs at the shell, so an unguarded throw here reaches
  // the root ErrorBoundary and takes the whole console down, not just the chip.
  useEffect(() => {
    if (!useUiStore.getState().recordOperator) {
      try {
        const saved = window.localStorage.getItem(OPERATOR_STORAGE_KEY);
        if (saved) setOperator(saved);
      } catch {
        // No persisted name available; the chip just starts empty.
      }
    }
  }, [setOperator]);

  const initials = operator.trim()
    ? operator
        .trim()
        .split(/\s+/)
        .map((w) => w[0] ?? '')
        .slice(0, 2)
        .join('')
        .toUpperCase()
    : 'OP';

  const save = () => {
    const v = draft.trim();
    setOperator(v);
    // A throw in an event handler escapes the ErrorBoundary entirely: the name
    // would be set but the popover would never close. The name still applies to
    // this session; it just won't survive a reload.
    try {
      if (v) window.localStorage.setItem(OPERATOR_STORAGE_KEY, v);
      else window.localStorage.removeItem(OPERATOR_STORAGE_KEY);
    } catch {
      // Storage unavailable — the in-memory operator still drives recording.
    }
    setOpen(false);
  };

  return (
    <div className="relative">
      <button
        type="button"
        aria-label="operator"
        data-testid="operator-chip"
        title={
          operator.trim()
            ? `Operator: ${operator} — saved into each recording`
            : 'Set operator name — saved into each recording'
        }
        onClick={() => {
          setDraft(operator);
          setOpen((v) => !v);
        }}
        className={cn(
          'flex h-8 w-8 items-center justify-center rounded-full border text-xs font-semibold',
          operator.trim()
            ? 'border-teal-200 bg-teal-50 text-teal-700 hover:border-teal-400'
            : 'border-gray-200 bg-gray-100 text-gray-600 hover:border-gray-300',
        )}
      >
        {initials}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-40 mt-2 w-72 rounded-card border border-gray-200 bg-white p-3 shadow-float">
          <label
            htmlFor="operator-name"
            className="mb-1.5 block text-[10.5px] font-semibold uppercase tracking-[0.05em] text-gray-500"
          >
            Operator — saved into each recording
          </label>
          {roster.length > 0 ? (
            <div className="flex flex-col gap-1" data-testid="operator-roster">
              {operator.trim() && !roster.includes(operator.trim()) && (
                <p className="mb-1 rounded-control border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
                  “{operator.trim()}” is not on the roster — pick a name below
                  (Settings &gt; Operators edits the list).
                </p>
              )}
              {roster.map((name) => (
                <button
                  key={name}
                  type="button"
                  data-testid={`operator-pick-${name}`}
                  onClick={() => {
                    setOperator(name);
                    try {
                      window.localStorage.setItem(OPERATOR_STORAGE_KEY, name);
                    } catch {
                      // Same as save(): unpersisted, but the pick still applies.
                    }
                    setOpen(false);
                  }}
                  className={cn(
                    'rounded-control border px-2.5 py-1.5 text-left text-sm',
                    name === operator.trim()
                      ? 'border-teal-300 bg-teal-50 font-semibold text-teal-700'
                      : 'border-gray-200 text-gray-700 hover:bg-gray-50',
                  )}
                >
                  {name}
                </button>
              ))}
            </div>
          ) : (
          <div className="flex gap-2">
            <input
              id="operator-name"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save();
                if (e.key === 'Escape') setOpen(false);
              }}
              placeholder="e.g. sadasue"
              autoFocus
              data-testid="operator-input"
              className="w-full rounded-control border border-gray-200 px-2 py-1.5 text-sm focus:border-teal-600 focus:outline-none"
            />
            <button
              type="button"
              onClick={save}
              className="rounded-control bg-teal-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-teal-800"
            >
              Save
            </button>
          </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The kairos wordmark + 6-tab nav + operator context chips, all in one row
 *  (design mock header). Always mounted — unlike the tab panel below it, it
 *  never unmounts on a tab switch. */
function Header({ active, config }: { active: V2TabId; config: RuntimeConfig }) {
  return (
    <header className="mb-2.5 flex flex-wrap items-center gap-4 lg:shrink-0">
      <a
        href="/"
        aria-label="kairos — recording console (home)"
        title="kairos — recording console (home)"
        className="flex items-center gap-[11px] rounded-control focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
      >
        <Hexagon size={30} />
        <span className="text-[20px] font-bold tracking-[-0.02em] text-gray-900">
          kairos
        </span>
      </a>
      <TabNav active={active} />
      <div className="flex-1" />
      <DomainChip domainId={config.defaults.ros_domain_id} />
      <ConnectionBadge />
      <OperatorChip />
    </header>
  );
}

/** The console shell: header (nav + status) above the active tab's panel.
 *  Split out from `App` because it calls hooks (`useActiveTab`) that must not
 *  run before the render-gate below has resolved the runtime config. */
function Shell({ config }: { config: RuntimeConfig }) {
  const active = useActiveTab();
  return (
    <>
      <Header active={active} config={config} />
      <TabPanel active={active} />
    </>
  );
}

/**
 * Standalone single-tab page (`?tab=<id>&solo=1`): renders ONLY that tab, no tab
 * nav — so an operator can keep e.g. the Monitor screen in its own window. It
 * runs its own SSE subscription (separate document) and links back to the
 * console. `tabId` is always a resolved v2 id (see `resolveTabId`).
 */
function SoloPage({ tabId, config }: { tabId: V2TabId; config: RuntimeConfig }) {
  const label = tabLabel(tabId);
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
          <span className="text-[15px] font-bold tracking-[-0.02em] text-gray-900">
            kairos
          </span>
          <span className="text-gray-300">/</span>
          <span className="text-[14px] font-semibold">{label}</span>
        </a>
        <div className="flex-1" />
        <DomainChip domainId={config.defaults.ros_domain_id} />
        <ConnectionBadge />
      </header>
      <section
        role="tabpanel"
        aria-label={label}
        className="min-h-0 flex-1 overflow-auto"
      >
        <PanelBoundary resetKey={tabId} standalone>
          <TabContent tabId={tabId} />
        </PanelBoundary>
      </section>
    </main>
  );
}

export function App() {
  // Render gate: wait for the backend config before showing the UI. config.ts
  // provides a dev-only fallback so the SPA renders without a backend. Still
  // fetched even though the v2 tab set is fixed client-side — this is where
  // the API base, SSE endpoint, ROS domain id and form defaults come from.
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
  // Any legacy id is redirected (and the URL rewritten) same as the main view.
  const route = readRoute();
  if (route.solo && route.tab) {
    const resolved = resolveTabId(route.tab);
    if (resolved !== route.tab) {
      window.history.replaceState(null, '', tabUrl(resolved, true));
    }
    return <SoloPage tabId={resolved} config={config} />;
  }

  return (
    <main className="min-h-screen bg-gray-50 px-[22px] pb-[22px] pt-2.5 lg:flex lg:h-svh lg:min-h-0 lg:flex-col lg:overflow-hidden">
      <EventStreamMount url={config.endpoints.events} />
      <Shell config={config} />
    </main>
  );
}
