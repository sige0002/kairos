import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { App } from './App';
import type { RuntimeConfig } from './config';
import { useUiStore } from './store/uiStore';
import { jsonResponse, renderWithClient } from './test/renderWithClient';

const STUB_CONFIG: RuntimeConfig = {
  endpoints: {
    api: '/api/v1',
    events: '/api/v1/events',
    webrtc: 'http://localhost:8002',
  },
  tabs: [
    { id: 'live', enabled: true },
    { id: 'graph', enabled: true },
    { id: 'runs', enabled: true },
    { id: 'validation', enabled: true },
    { id: 'dataset', enabled: false },
    { id: 'config', enabled: true },
  ],
  defaults: {},
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
    return jsonResponse({ run_id: null, state: 'idle' });
  if (url.includes('/topics')) return jsonResponse([]);
  if (url.includes('/runs')) return jsonResponse({ items: [], next_cursor: null });
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

test('the current tab has a pop-out that opens its solo page in a new window', async () => {
  const openSpy = vi.fn();
  vi.stubGlobal('open', openSpy);
  renderWithClient(<App />);
  // Default active tab is Live; the pop-out targets the current tab.
  await waitFor(() => screen.getByRole('tab', { name: 'Live' }));

  fireEvent.click(screen.getByRole('button', { name: /open Live in a new window/i }));
  expect(openSpy).toHaveBeenCalledTimes(1);
  const openedUrl = String(openSpy.mock.calls[0]?.[0] ?? '');
  expect(openedUrl).toMatch(/tab=live/);
  expect(openedUrl).toMatch(/solo=1/);
});

test('a solo URL (?tab=...&solo=1) renders only that tab, no tablist', async () => {
  window.history.replaceState(null, '', '/?tab=graph&solo=1');
  renderWithClient(<App />);
  await waitFor(() =>
    expect(screen.queryByText(/Loading kairos/i)).not.toBeInTheDocument(),
  );
  // Standalone page: no tab navigation; the back link to the console is present.
  expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  expect(screen.getByTitle('Back to the kairos console')).toBeInTheDocument();
});

test('render-gates on backend config, then shows the registry-driven tabs', async () => {
  renderWithClient(<App />);

  // The render gate shows a loading state until the config resolves.
  expect(screen.getByText(/Loading kairos/i)).toBeInTheDocument();

  await waitFor(() => {
    expect(screen.getByRole('tab', { name: 'Live' })).toBeInTheDocument();
  });
  // Disabled tab from config is rendered but disabled.
  expect(screen.getByRole('tab', { name: 'Datasets' })).toBeDisabled();
  // First enabled tab is selected by default.
  expect(screen.getByRole('tab', { name: 'Live' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

test('only enabled tabs are selectable; disabled tabs render but cannot activate', async () => {
  renderWithClient(<App />);
  await waitFor(() => screen.getByRole('tab', { name: 'Live' }));

  const enabled = ['Live', 'Graph', 'Recordings', 'Validation', 'Config'];
  for (const name of enabled) {
    expect(screen.getByRole('tab', { name })).toBeEnabled();
  }
  expect(screen.getByRole('tab', { name: 'Datasets' })).toBeDisabled();
});
