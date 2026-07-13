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
  expect(screen.getByText('Monitor')).toBeInTheDocument();
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
