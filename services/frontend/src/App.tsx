import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
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
import { resolveTabId, V2_TABS, type V2TabId } from './v2/tabs';
import { useOnPopState } from './v2/shared/useOnPopState';
import { HIT_AREA_CHIP, HIT_AREA_TAB } from './v2/shared/hitArea';
import { PanelBoundary } from './components/ErrorBoundary';
import { Hexagon, StatusDot, cn } from './components/ui';
import { OPERATOR_STORAGE_KEY, type SseStatus } from './store/uiStore';
import { StoreHealthBanner } from './v2/store/StoreHealthBanner';
import { useLocale } from './i18n';

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
  const { t } = useTranslation('common');
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
      return (
        <p className="text-sm text-text-muted">
          {t('shell.unknownTab', { tab: tabId })}
        </p>
      );
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
  const { t } = useTranslation('common');
  const setActiveTab = useUiStore((s) => s.setActiveTab);
  return (
    <nav
      role="tablist"
      aria-label={t('shell.tabsLabel')}
      // gap-y-2 only: the tabs' hit areas reach 4px above and below each tab
      // (HIT_AREA_TAB), so a wrapped nav at narrow widths needs 8px between
      // ROWS or the two rows' targets would overlap. The 3px column gap is
      // untouched — nothing expands sideways.
      className="flex flex-wrap gap-x-[3px] gap-y-2 rounded-[12px] border border-border bg-surface-muted p-1"
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
              HIT_AREA_TAB,
              on
                ? 'bg-accent font-semibold text-text-inverse shadow-sm'
                : 'font-medium text-text-secondary hover:text-text-primary',
            )}
          >
            {t(`tabs.${tab.id}`)}
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
  const { t } = useTranslation('common');
  const label = t(`tabs.${active}`);
  return (
    <div className="flex flex-col gap-2 lg:min-h-0 lg:flex-1">
      <div className="flex justify-end lg:shrink-0">
        <button
          type="button"
          aria-label={t('actions.openTabInNewWindow', { tab: label })}
          title={t('actions.openInNewWindow')}
          onClick={() => openTabWindow(active)}
          className="inline-flex items-center gap-1 rounded-control border border-border px-2.5 py-1.5 text-[12.5px] text-text-muted transition-colors hover:bg-surface hover:text-accent"
        >
          ↗<span className="hidden sm:inline">{t('actions.openInNewWindow')}</span>
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
  const { t } = useTranslation('common');
  const status = useUiStore((s) => s.sseStatus);
  const bridge = useUiStore((s) => s.monitorBridge);
  const tone: Record<SseStatus, 'green' | 'amber' | 'gray'> = {
    open: 'green',
    connecting: 'amber',
    reconnecting: 'amber',
    closed: 'gray',
  };
  const label: Record<SseStatus, string> = {
    open: t('shell.connection.connected'),
    connecting: t('shell.connection.connecting'),
    reconnecting: t('shell.connection.reconnecting'),
    closed: t('shell.connection.disconnected'),
  };
  const robotOffline = status === 'open' && bridge === 'down';
  const checkingRobot = status === 'open' && bridge === null;
  const live = status === 'open' && bridge === 'up';
  return (
    <span
      data-testid="connection-status"
      title={
        robotOffline
          ? t('shell.connection.robotOfflineHelp')
          : checkingRobot
            ? t('shell.connection.checkingRobotHelp')
            : undefined
      }
      className={cn(
        'inline-flex items-center gap-2 rounded-control border px-3 py-2',
        live
          ? 'border-status-live-border bg-status-live-bg'
          : robotOffline || checkingRobot
            ? 'border-status-warning-border bg-status-warning-bg'
            : 'border-border bg-surface',
      )}
    >
      <StatusDot
        tone={robotOffline || checkingRobot ? 'amber' : tone[status]}
        pulse={live}
      />
      <span
        className={cn(
          'font-mono text-[12.5px] font-semibold',
          live
            ? 'text-status-live-text'
            : robotOffline || checkingRobot
              ? 'text-status-warning-text'
              : 'text-text-secondary',
        )}
      >
        {robotOffline
          ? t('shell.connection.robotOffline')
          : checkingRobot
            ? t('shell.connection.checkingRobot')
            : label[status]}
      </span>
    </span>
  );
}

/**
 * Active ROS 2 domain id, shown as a small mono chip next to the connection
 * badge (operator context). Hidden when the backend omits it.
 */
function DomainChip({ domainId }: { domainId?: number }) {
  const { t } = useTranslation('common');
  if (domainId === undefined) return null;
  return (
    <span
      data-testid="ros-domain"
      title={t('shell.domainTitle', { domainId: String(domainId) })}
      className="inline-flex items-center gap-1.5 rounded-control border border-border bg-surface px-3 py-2 font-mono text-[12.5px] font-semibold text-text-secondary"
    >
      <span className="uppercase tracking-[0.04em] text-text-muted">
        {t('shell.domain')}
      </span>
      {domainId}
    </span>
  );
}

/** Mounts the single SSE subscription for the app's lifetime. */
function EventStreamMount({ url }: { url: string }) {
  useEventStream(url);
  return null;
}

/** Hydrates operator attribution at application startup, independently of the
 * header chip. A solo Collect window has no main header, so the chip cannot be
 * the source of truth. The storage listener keeps separate windows aligned. */
function OperatorHydrationMount() {
  const hydrate = useUiStore((s) => s.hydrateRecordOperator);
  const setOperator = useUiStore((s) => s.setRecordOperator);

  useEffect(() => {
    let saved = '';
    try {
      saved = window.localStorage.getItem(OPERATOR_STORAGE_KEY) ?? '';
    } catch {
      // Storage can be denied. Mark hydration complete so the UI can show the
      // honest empty-operator gate instead of waiting forever.
    }
    hydrate(saved);

    const onStorage = (event: StorageEvent) => {
      if (event.key !== OPERATOR_STORAGE_KEY) return;
      setOperator(event.newValue ?? '');
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [hydrate, setOperator]);

  return null;
}

/** Operator identity chip (v1's Live operator input, relocated): click to set
 *  the name recorded with each episode. Writes the SAME uiStore field the
 *  record-start flow reads (`recordOperator` → /record/start `operator`), plus
 *  localStorage so the name survives a reload — the store itself is in-memory. */
function OperatorChip() {
  const { t } = useTranslation('common');
  const operator = useUiStore((s) => s.recordOperator);
  const setOperator = useUiStore((s) => s.setRecordOperator);
  // Attribution roster (Settings > Operators). Non-empty → the popover is a
  // PICKER (no free text: that is how "yuki"/"Yuki"/"yuki_2" get into labels);
  // empty → the pre-roster free-text input stands and nothing is gated.
  const roster = useOperators();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');

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
        aria-label={
          operator.trim()
            ? t('shell.operator.namedLabel', { operator })
            : t('shell.operator.setLabel')
        }
        data-testid="operator-chip"
        title={
          operator.trim()
            ? t('shell.operator.namedTitle', { operator })
            : t('shell.operator.setTitle')
        }
        onClick={() => {
          setDraft(operator);
          setOpen((v) => !v);
        }}
        className={cn(
          'inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 text-xs font-semibold',
          HIT_AREA_CHIP,
          operator.trim()
            ? 'border-status-adopted-border bg-status-adopted-bg text-status-adopted-text hover:border-status-adopted-accent'
            : 'border-border bg-surface-muted text-text-secondary hover:border-border-strong',
        )}
      >
        <span
          aria-hidden
          className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-surface/70 px-1 font-mono text-[10px]"
        >
          {initials}
        </span>
        <span data-testid="operator-visible-name" className="max-w-[160px] truncate">
          {operator.trim() || t('shell.operator.set')}
        </span>
      </button>
      {open && (
        <div className="absolute right-0 top-full z-40 mt-2 w-72 rounded-card border border-border bg-surface-elevated p-3 shadow-float">
          <label
            htmlFor="operator-name"
            className="mb-1.5 block text-[10.5px] font-semibold uppercase tracking-[0.05em] text-text-muted"
          >
            {t('shell.operator.label')}
          </label>
          {roster.length > 0 ? (
            <div className="flex flex-col gap-1" data-testid="operator-roster">
              {operator.trim() && !roster.includes(operator.trim()) && (
                <p className="mb-1 rounded-control border border-status-warning-border bg-status-warning-bg px-2 py-1 text-[11px] text-status-warning-text">
                  {t('shell.operator.notOnRoster', { operator: operator.trim() })}
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
                      ? 'border-status-adopted-border bg-status-adopted-bg font-semibold text-status-adopted-text'
                      : 'border-border text-text-secondary hover:bg-interaction-hover',
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
                  // Mid-conversion, both of these keys belong to the IME: Enter
                  // confirms the candidate and Escape closes the candidate
                  // window. Taking either would commit or discard on a press the
                  // typist meant for neither — and, for Enter, would save the
                  // UNCONVERTED text as the operator's name while swallowing the
                  // very keystroke the IME was waiting for. Guarding the whole
                  // handler rather than one branch, because the answer is the
                  // same for both: this keystroke is not ours yet.
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === 'Enter') {
                    // The save lifts Collect's operator gate, and Collect hands
                    // focus to the Start button it has just enabled — inside this
                    // same event. Without cancelling the default action, the
                    // browser then activates that freshly focused button, so
                    // typing your name and pressing Enter STARTS A RECORDING
                    // (#26; a 6-minute runaway take in the acceptance run).
                    //
                    // Same rule as the arming Cancel guard (#8): a control must
                    // not answer the press that revealed it. Collect's own
                    // commit-on-Enter field already does this (Modals.tsx); this
                    // one was the outlier.
                    //
                    // No stopPropagation: the only window-level key listener
                    // (useCollectShortcuts) already ignores events whose target
                    // is an input, so nothing upstream acts on this. Stopping
                    // propagation would buy nothing and would quietly break the
                    // next global handler that legitimately wants to see it.
                    e.preventDefault();
                    save();
                  }
                  if (e.key === 'Escape') setOpen(false);
                }}
                placeholder={t('shell.operator.placeholder')}
                autoFocus
                data-testid="operator-input"
                className="w-full rounded-control border border-border bg-surface-control px-2 py-1.5 text-sm text-text-primary focus:border-accent focus:outline-none"
              />
              <button
                type="button"
                onClick={save}
                className="rounded-control bg-accent px-3 py-1.5 text-sm font-semibold text-text-inverse hover:bg-accent-strong"
              >
                {t('actions.save')}
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
  const { t } = useTranslation('common');
  return (
    <header className="mb-2.5 flex flex-wrap items-center gap-4 lg:shrink-0">
      <a
        href="/"
        aria-label={t('shell.home')}
        title={t('shell.home')}
        className="flex items-center gap-[11px] rounded-control focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <Hexagon size={30} />
        <span className="text-[20px] font-bold tracking-[-0.02em] text-text-primary">
          kairos
        </span>
      </a>
      <TabNav active={active} />
      <div className="flex-1" />
      <DomainChip domainId={config.defaults.ros_domain_id} />
      <ConnectionBadge />
      <OperatorChip />
      <BatchRestoreNotice />
    </header>
  );
}

function BatchRestoreNotice() {
  const { t } = useTranslation('common');
  const batchRestoreIssue = useUiStore((s) => s.batchRestoreIssue);
  if (batchRestoreIssue !== 'ambiguous') return null;
  return (
    <span
      role="status"
      data-testid="batch-restore-issue"
      className="rounded-control border border-status-warning-border bg-status-warning-bg px-3 py-2 text-[12px] font-medium text-status-warning-text"
    >
      {t('shell.batchRestore')}
    </span>
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
      <StoreHealthBanner />
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
  const { t } = useTranslation('common');
  const activeTab = useUiStore((s) => s.activeTab);
  const setActiveTab = useUiStore((s) => s.setActiveTab);
  const [seeded, setSeeded] = useState(false);
  // Always honour the URL on the first paint. A shared uiStore can still hold
  // another tab from a previously-open console window; letting that win would
  // make a direct `?tab=review&solo=1` request open the wrong screen.
  const active = seeded && activeTab ? resolveTabId(activeTab) : tabId;
  const label = t(`tabs.${active}`);

  useEffect(() => {
    if (!seeded) {
      setActiveTab(tabId);
      setSeeded(true);
    }
  }, [seeded, setActiveTab, tabId]);

  useEffect(() => {
    if (active === tabId) return;
    window.history.replaceState(null, '', tabUrl(active, true));
  }, [active, tabId]);

  return (
    <main className="flex h-screen flex-col bg-app px-[22px] pb-[22px] pt-2.5">
      <EventStreamMount url={config.endpoints.events} />
      <header className="mb-2 flex flex-wrap items-center gap-3">
        <a
          href={tabUrl(active, false)}
          title={t('actions.backToConsole')}
          className="flex items-center gap-2 rounded-control text-text-secondary hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <Hexagon size={20} />
          <span className="text-[15px] font-bold tracking-[-0.02em] text-text-primary">
            kairos
          </span>
          <span className="text-border-strong">/</span>
          <span className="text-[14px] font-semibold">{label}</span>
        </a>
        <div className="flex-1" />
        <DomainChip domainId={config.defaults.ros_domain_id} />
        <ConnectionBadge />
        {active === 'collect' && <OperatorChip />}
        <BatchRestoreNotice />
      </header>
      <StoreHealthBanner solo />
      <section
        role="tabpanel"
        aria-label={label}
        className="min-h-0 flex-1 overflow-auto"
      >
        <PanelBoundary resetKey={active} standalone>
          <TabContent tabId={active} />
        </PanelBoundary>
      </section>
    </main>
  );
}

export function App() {
  // This subscription deliberately sits at the application boundary. Legacy
  // presentation helpers are pure functions, so changing language must also
  // rerender already-mounted formatter consumers without remounting their
  // stateful Collect/Review/Datasets screens.
  const { locale } = useLocale();
  const { t } = useTranslation('common');
  const operatorHydrated = useUiStore((s) => s.operatorHydrated);
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

  // This mount intentionally lives above both main and solo shells: identity
  // is application context, not a header widget.
  const operatorHydration = <OperatorHydrationMount />;

  if (isPending) {
    return (
      <>
        {operatorHydration}
        <main className="flex min-h-screen items-center gap-3 bg-app p-[22px] text-text-muted">
          <Hexagon size={22} />
          {t('shell.loadingConsole')}
        </main>
      </>
    );
  }
  if (isError) {
    return (
      <>
        {operatorHydration}
        <main className="min-h-screen bg-app p-[22px] text-status-danger-text">
          {t('shell.configurationFailed', { error: String(error) })}
        </main>
      </>
    );
  }

  if (!operatorHydrated) {
    return (
      <>
        {operatorHydration}
        <main className="flex min-h-screen items-center gap-3 bg-app p-[22px] text-text-muted">
          <Hexagon size={22} />
          {t('shell.loadingOperator')}
        </main>
      </>
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
    return (
      <>
        {operatorHydration}
        <SoloPage tabId={resolved} config={config} />
      </>
    );
  }

  return (
    <>
      {operatorHydration}
      <main
        data-locale={locale}
        className="min-h-screen bg-app px-[22px] pb-[22px] pt-2.5 lg:flex lg:h-svh lg:min-h-0 lg:flex-col lg:overflow-hidden"
      >
        <EventStreamMount url={config.endpoints.events} />
        <Shell config={config} />
      </main>
    </>
  );
}
