import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { App } from './App';
import { ErrorBoundary, PanelBoundary } from './components/ErrorBoundary';
import type { RuntimeConfig } from './config';
import { useUiStore } from './store/uiStore';
import { jsonResponse, renderWithClient } from './test/renderWithClient';

const STUB_CONFIG: RuntimeConfig = {
  endpoints: {
    api: '/api/v1',
    events: '/api/v1/events',
    webrtc: 'http://localhost:8002',
  },
  // The v2 tab set is fixed client-side (see src/v2/tabs.ts) — the backend's
  // `tabs` field is no longer consulted for the nav, so it's left empty here.
  tabs: [],
  defaults: { ros_domain_id: 42 },
  schemas: {},
};

// Minimal EventSource stub so useEventStream can mount without a real network.
class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  close = vi.fn();
  constructor(public url: string) {}
}

// Route fetch by URL so feature tabs don't blow up on mount.
function routedFetch(url: string): Response {
  if (url.includes('/config')) return jsonResponse(STUB_CONFIG);
  if (url.includes('/record/status'))
    // A fresh recorder sits in `created` and reports an empty live set — there
    // is no `idle` on the wire.
    return jsonResponse({ run_id: null, state: 'created', live_capture_ids: [] });
  if (url.includes('/topics')) return jsonResponse([]);
  if (url.includes('/captures')) return jsonResponse({ items: [], next_cursor: null });
  return jsonResponse({});
}

beforeEach(() => {
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    (input: RequestInfo | URL) =>
      Promise.resolve(routedFetch(String(input))) as Promise<Response>,
  );
  useUiStore.setState({ activeTab: '', sseStatus: 'closed' });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // Tabs sync the active tab into the URL; reset so solo/deep-link tests are isolated.
  window.history.replaceState(null, '', '/');
});

test('defaults to Collect and shows all six v2 tabs', async () => {
  renderWithClient(<App />);
  await waitFor(() => screen.getByRole('tab', { name: 'Collect' }));

  for (const name of [
    'Collect',
    'Review',
    'Datasets',
    'Validation',
    'Monitor',
    'Settings',
  ]) {
    expect(screen.getByRole('tab', { name })).toBeInTheDocument();
  }
  expect(screen.getByRole('tab', { name: 'Collect' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  // Header context chips: ROS domain (from config.defaults) + SSE status.
  expect(screen.getByTestId('ros-domain')).toHaveTextContent('42');
  expect(screen.getByTestId('connection-status')).toBeInTheDocument();
});

test('clicking a tab switches the active panel', async () => {
  renderWithClient(<App />);
  await waitFor(() => screen.getByRole('tab', { name: 'Collect' }));

  fireEvent.click(screen.getByRole('tab', { name: 'Review' }));
  await waitFor(() =>
    expect(screen.getByRole('tab', { name: 'Review' })).toHaveAttribute(
      'aria-selected',
      'true',
    ),
  );
  expect(screen.getByRole('tab', { name: 'Collect' })).toHaveAttribute(
    'aria-selected',
    'false',
  );
});

// #14 — heading structure. The console had no h1 or h2 anywhere in the shell,
// so a screen-reader user could not navigate it by heading at all. This covers
// the SHELL's half of the fix — that the mounted screen titles the document
// and that switching tabs retitles it. Each screen's own outline is asserted in
// its own test file (src/test/headingOutline.ts).
test('the mounted screen titles the document, and switching tabs retitles it', async () => {
  renderWithClient(<App />);
  await waitFor(() => screen.getByRole('tab', { name: 'Collect' }));

  // One h1, naming where you are. Exactly one because the shell mounts a single
  // screen at a time — a second would mean two screens are alive at once.
  const h1s = await screen.findAllByRole('heading', { level: 1 });
  expect(h1s).toHaveLength(1);
  expect(h1s[0]).toHaveTextContent('Collect');

  fireEvent.click(screen.getByRole('tab', { name: 'Review' }));
  await waitFor(() => {
    const next = screen.getAllByRole('heading', { level: 1 });
    expect(next).toHaveLength(1);
    expect(next[0]).toHaveTextContent('Review');
  });
}, 20000);

// E-28. The browser can change the URL underneath a running SPA — Back,
// Forward, a session restore, a bfcache resume — and until this was handled the
// console kept rendering the tab its store held while its own URL named a
// different one, then the mirror effect below rewrote the URL back, silently
// undoing the navigation.
//
// WHAT THIS DOES NOT CLAIM. In-app tab switches add ZERO history entries, so
// Back does not move between tabs today — it leaves the console. That is a
// property of the CODE, not a lucky measurement: `pushState` appears nowhere in
// src/ outside two comments discussing it (`grep -rn pushState src/`), and
// every history write here and in the Datasets screen is `replaceState`. It was
// also measured (chromium: history.length 2 before and after two switches), but
// the grep is the durable form — it cannot come out differently on another run. This test protects the invariant that
// WHEN the URL changes under us, the console shows what that URL would show on
// a fresh load — which is what bfcache and session restore actually do, and
// what every history entry would do the moment anyone adds a `pushState`.
test('a history navigation that changes ?tab= is followed, not silently undone', async () => {
  window.history.replaceState(null, '', '/?tab=datasets');
  renderWithClient(<App />);
  await waitFor(() =>
    expect(screen.getByRole('tab', { name: 'Datasets' })).toHaveAttribute(
      'aria-selected',
      'true',
    ),
  );

  // What a restored history entry looks like from inside the document.
  window.history.replaceState(null, '', '/?tab=monitor');
  fireEvent.popState(window);

  await waitFor(() =>
    expect(screen.getByRole('tab', { name: 'Monitor' })).toHaveAttribute(
      'aria-selected',
      'true',
    ),
  );
  expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'panel-monitor');
  // And the URL the browser restored is left alone rather than rewritten back.
  expect(window.location.search).toMatch(/tab=monitor/);
});

// A restored entry that names no tab is not a reason to keep showing the old
// one: a fresh load of that URL would show the default, so this does too.
test('a history navigation to a URL with no ?tab= lands on the default tab', async () => {
  window.history.replaceState(null, '', '/?tab=monitor');
  renderWithClient(<App />);
  await waitFor(() =>
    expect(screen.getByRole('tab', { name: 'Monitor' })).toHaveAttribute(
      'aria-selected',
      'true',
    ),
  );

  window.history.replaceState(null, '', '/');
  fireEvent.popState(window);

  await waitFor(() =>
    expect(screen.getByRole('tab', { name: 'Collect' })).toHaveAttribute(
      'aria-selected',
      'true',
    ),
  );
});

test('a legacy deep link (?tab=graph) redirects to its v2 home (Monitor)', async () => {
  window.history.replaceState(null, '', '/?tab=graph');
  renderWithClient(<App />);

  await waitFor(() =>
    expect(screen.getByRole('tab', { name: 'Monitor' })).toHaveAttribute(
      'aria-selected',
      'true',
    ),
  );
  expect(window.location.search).toMatch(/tab=monitor/);
});

test('the current tab has a pop-out that opens its solo page in a new window', async () => {
  const openSpy = vi.fn();
  vi.stubGlobal('open', openSpy);
  renderWithClient(<App />);
  // Default active tab is Collect; the pop-out targets the current tab.
  await waitFor(() => screen.getByRole('tab', { name: 'Collect' }));

  fireEvent.click(
    screen.getByRole('button', { name: /open Collect in a new window/i }),
  );
  expect(openSpy).toHaveBeenCalledTimes(1);
  const openedUrl = String(openSpy.mock.calls[0]?.[0] ?? '');
  expect(openedUrl).toMatch(/tab=collect/);
  expect(openedUrl).toMatch(/solo=1/);
});

test('a solo URL (?tab=...&solo=1) renders only that tab, no tab nav', async () => {
  window.history.replaceState(null, '', '/?tab=monitor&solo=1');
  renderWithClient(<App />);
  await waitFor(() =>
    expect(screen.queryByText(/Loading kairos/i)).not.toBeInTheDocument(),
  );
  // Standalone page: no tab navigation; the back link to the console is present.
  expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  expect(screen.getByTitle('Back to the kairos console')).toBeInTheDocument();
});

test('a legacy solo deep link (?tab=probe&solo=1) redirects and rewrites the URL', async () => {
  window.history.replaceState(null, '', '/?tab=probe&solo=1');
  renderWithClient(<App />);
  await waitFor(() =>
    expect(screen.queryByText(/Loading kairos/i)).not.toBeInTheDocument(),
  );
  // The screen's own h1 (#14). "Monitor" is now on screen twice — the solo
  // header's label and this heading — so the assertion names which one it
  // means, and in doing so proves the redirect landed on the Monitor SCREEN
  // rather than merely rewriting the URL.
  expect(screen.getByRole('heading', { level: 1, name: 'Monitor' })).toBeInTheDocument();
  expect(window.location.search).toMatch(/tab=monitor/);
  expect(window.location.search).toMatch(/solo=1/);
});

test('the operator chip sets uiStore.recordOperator (sent with /record/start) and persists it', async () => {
  window.history.replaceState(null, '', '/');
  window.localStorage.removeItem('kairos.operator');
  useUiStore.setState({ recordOperator: '' });
  renderWithClient(<App />);
  await waitFor(() =>
    expect(screen.queryByText(/Loading kairos/i)).not.toBeInTheDocument(),
  );

  const chip = screen.getByTestId('operator-chip');
  expect(chip).toHaveTextContent('OP'); // unset → placeholder initials

  fireEvent.click(chip);
  fireEvent.change(screen.getByTestId('operator-input'), {
    target: { value: 'Sadasue Yuki' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  expect(useUiStore.getState().recordOperator).toBe('Sadasue Yuki');
  expect(window.localStorage.getItem('kairos.operator')).toBe('Sadasue Yuki');
  expect(chip).toHaveTextContent('SY'); // initials from the saved name
});

test('the shell survives a browser where localStorage access throws', async () => {
  // Private mode / site data blocked by policy: access THROWS instead of
  // returning null. The read runs in a shell-level effect, so an unguarded throw
  // reaches the root ErrorBoundary and the WHOLE console goes down; the writes
  // are in event handlers, where a throw escapes the boundary entirely and would
  // leave the popover open with the name unpersisted. Both are exercised here.
  const boom = () => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  };
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(boom);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(boom);
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(boom);
  window.history.replaceState(null, '', '/');
  useUiStore.setState({ recordOperator: '' });

  // Mounted under the REAL root boundary from main.tsx, and asserted on the
  // boundary itself rather than on "something rendered" — a later `try`/`catch`
  // that swallowed the throw into a broken state would still render a chip.
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  renderWithClient(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>,
  );
  await waitFor(() => expect(screen.queryByText(/Loading kairos/i)).not.toBeInTheDocument());

  const caught = errorSpy.mock.calls
    .filter((c) => String(c[0]).includes('Unhandled UI error'))
    .map((c) => String((c[1] as Error | undefined)?.message ?? c[1]));
  expect(caught).toEqual([]);
  expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();

  // The shell rendered at all — the mount-time read did not take it down.
  const chip = screen.getByTestId('operator-chip');
  fireEvent.click(chip);
  fireEvent.change(screen.getByTestId('operator-input'), { target: { value: 'Sadasue Yuki' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  // The name applies to this session and the popover closed, even though
  // nothing could be persisted.
  expect(useUiStore.getState().recordOperator).toBe('Sadasue Yuki');
  expect(chip).toHaveTextContent('SY');
  expect(screen.queryByTestId('operator-input')).not.toBeInTheDocument();
});

// E-23, third site. A malformed payload that throws during render used to reach
// the ROOT boundary, which replaces the whole document: the tab bar went with
// it, the operator could not leave the tab, and nothing healed it — measured,
// four subsequent good SSE events left it dead, because `getDerivedStateFromError`
// sets `state.error` and only `window.location.reload()` clears it.
//
// The panel gets its own boundary so a bad payload costs the PANEL. The tab bar
// surviving is the whole point: it is the operator's way out, and switching
// tabs resets the boundary.
test('a screen that throws costs the panel, not the console — and the tab bar survives', () => {
  const Boom = () => {
    throw new Error('malformed payload reached render');
  };
  render(
    <PanelBoundary resetKey="monitor">
      <Boom />
    </PanelBoundary>,
  );
  expect(screen.getByTestId('panel-error')).toBeInTheDocument();
  expect(screen.getByTestId('panel-error')).toHaveTextContent(/malformed payload/);
});

// #14. The fallback REPLACES the screen, so the screen's own ScreenTitle h1
// unmounts with it. Titling the fallback h2 would leave the document with no h1
// at all — the precise gap the heading sweep closed — for the one state where a
// screen-reader user most needs to know what they are looking at.
test('a panel that has thrown still titles the document', () => {
  const Boom = () => {
    throw new Error('malformed payload reached render');
  };
  render(
    <PanelBoundary resetKey="monitor">
      <Boom />
    </PanelBoundary>,
  );
  const h1s = screen.getAllByRole('heading', { level: 1 });
  expect(h1s).toHaveLength(1);
  expect(h1s[0]).toHaveTextContent('This screen stopped rendering');
});

test('switching tabs clears a panel that had thrown, with no reload', () => {
  const Boom = () => {
    throw new Error('boom');
  };
  const { rerender } = render(
    <PanelBoundary resetKey="monitor">
      <Boom />
    </PanelBoundary>,
  );
  expect(screen.getByTestId('panel-error')).toBeInTheDocument();

  // The operator leaves the tab. Same boundary instance, new key.
  rerender(
    <PanelBoundary resetKey="collect">
      <p>collect is fine</p>
    </PanelBoundary>,
  );
  expect(screen.queryByTestId('panel-error')).not.toBeInTheDocument();
  expect(screen.getByText('collect is fine')).toBeInTheDocument();
});

// The recovery a panel offers has to exist where it is shown. In the shell the
// tab bar is the way out; a popped-out window (?solo=1) has no tabs and a
// constant resetKey, so the only real recovery there is a reload — and
// promising tab-switching would send the operator hunting for tabs that are
// not on the page.
test('the panel error offers the recovery that exists where it is shown', () => {
  const Boom = () => {
    throw new Error('boom');
  };
  const { unmount } = render(
    <PanelBoundary resetKey="monitor">
      <Boom />
    </PanelBoundary>,
  );
  expect(screen.getByTestId('panel-error')).toHaveTextContent(/switching tabs/);
  unmount();

  render(
    <PanelBoundary resetKey="monitor" standalone>
      <Boom />
    </PanelBoundary>,
  );
  expect(screen.getByTestId('panel-error')).toHaveTextContent(/reloading it is the way back/);
  expect(screen.getByTestId('panel-error')).not.toHaveTextContent(/switching tabs/);
});
