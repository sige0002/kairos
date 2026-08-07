// E-28, the shell half: back / forward / session restore, and what they leave
// behind. App.test.tsx already pins that a history navigation which changes
// `?tab=` is FOLLOWED rather than silently rewritten back, that a URL naming no
// tab lands on the default, and that legacy ids redirect. Two halves of the
// verdict sentence were not covered anywhere, and both are about what survives
// the navigation rather than what it selects:
//
//   * a modal left open on the tab being navigated AWAY from, and
//   * the keyboard shortcut layer after the console comes BACK to a tab
//     (a fresh mount — the shell unmounts the panel on every switch).
//
// A history navigation is driven the way the browser presents one from inside
// the document: rewrite the URL, then dispatch `popstate` (the same mechanism
// App.test.tsx uses).

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { App } from './App';
import type { RuntimeConfig } from './config';
import { useUiStore } from './store/uiStore';
import { jsonResponse, renderWithClient } from './test/renderWithClient';
import { __resetBatchStore } from './v2/collect/useBatchMachine';

const STUB_CONFIG: RuntimeConfig = {
  endpoints: {
    api: '/api/v1',
    events: '/api/v1/events',
    webrtc: 'http://localhost:8002',
  },
  tabs: [],
  defaults: { ros_domain_id: 42, default_topics: ['/hsrb/joint_states'] },
  schemas: {},
};

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

/** Every request this shell makes, so a shortcut's effect is observable. */
const calls: string[] = [];

function routedFetch(url: string, init?: RequestInit): Response {
  calls.push(`${init?.method ?? 'GET'} ${url}`);
  if (url.includes('/config')) return jsonResponse(STUB_CONFIG);
  if (url.includes('/record/start')) {
    return jsonResponse({
      capture_id: 'cap_hist',
      run_id: 'run_hist',
      state: 'recording',
      review_status: 'pending',
      review_revision: 0,
    });
  }
  if (url.includes('/record/status'))
    return jsonResponse({ run_id: null, state: 'created', live_capture_ids: [] });
  if (url.includes('/topics')) return jsonResponse([]);
  if (url.includes('/captures')) return jsonResponse({ items: [], next_cursor: null });
  if (url.includes('/batches')) return jsonResponse({ items: [] });
  return jsonResponse({});
}

/** What the browser does to a running SPA on Back / Forward / a restore. */
function navigateHistoryTo(search: string): void {
  window.history.replaceState(null, '', search);
  fireEvent.popState(window);
}

function startCalls(): number {
  return calls.filter((c) => c.includes('/record/start')).length;
}

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    (input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(routedFetch(String(input), init)) as Promise<Response>,
  );
  useUiStore.setState({
    activeTab: '',
    sseStatus: 'closed',
    recordOperator: 'op',
    recordSelected: new Set<string>(),
    recordCustomized: false,
  });
  __resetBatchStore();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

// A dialog is a modal overlay at a high z-index covering the whole viewport. If
// one outlives the panel it belongs to, the operator arrives on the new tab
// behind it — and the Collect shortcut layer suppresses itself while any
// registered overlay is open, so a stranded dialog is also how "the shortcuts
// all died" would happen.
test('E-28: a dialog open on the tab being left does not survive the navigation', async () => {
  window.history.replaceState(null, '', '/?tab=collect');
  renderWithClient(<App />);
  await waitFor(() =>
    expect(screen.getByRole('tab', { name: 'Collect' })).toHaveAttribute(
      'aria-selected',
      'true',
    ),
  );

  fireEvent.click(screen.getByRole('button', { name: /Batch menu/ }));
  fireEvent.click(screen.getByRole('button', { name: /End batch early/ }));
  // Positive control: there really is a dialog to strand.
  expect(screen.getByRole('dialog')).toBeInTheDocument();

  navigateHistoryTo('/?tab=monitor');

  await waitFor(() =>
    expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'panel-monitor'),
  );
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

  // And it does not come back with the tab: the overlay flags are screen state,
  // not part of the batch machine's module store, so a return lands on a clean
  // screen rather than on a dialog the operator abandoned two tabs ago.
  navigateHistoryTo('/?tab=collect');
  await waitFor(() =>
    expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'panel-collect'),
  );
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

// The shortcut layer is registered on the WINDOW by useBatchMachine, which
// lives in the panel the shell unmounts on every tab switch. So the claim has
// two halves and each is the other's control: the listener LEAVES with the
// panel (or `r` starts a recording from a tab that shows no recording controls
// — a hidden action, and the failure mode a listener that is merely never
// re-registered still looks fine under), and it COMES BACK with it.
test('E-28: the keyboard shortcuts leave with the panel and are live again on return', async () => {
  window.history.replaceState(null, '', '/?tab=collect');
  renderWithClient(<App />);
  await waitFor(() => expect(screen.getByTestId('start-recording')).toBeEnabled());
  expect(startCalls()).toBe(0);

  navigateHistoryTo('/?tab=monitor');
  await waitFor(() =>
    expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'panel-monitor'),
  );

  // Collect is not on screen: its shortcut must not be either.
  fireEvent.keyDown(window, { key: 'r' });
  await new Promise((r) => setTimeout(r, 50));
  expect(startCalls()).toBe(0);

  navigateHistoryTo('/?tab=collect');
  await waitFor(() => expect(screen.getByTestId('start-recording')).toBeEnabled());

  // Same key, same window, and now it reaches the recorder — so the assertion
  // above was the guard doing its job, not the harness failing to deliver keys.
  fireEvent.keyDown(window, { key: 'r' });
  await waitFor(() => expect(startCalls()).toBe(1));
});
