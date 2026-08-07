// E-23 — that the SHELL actually wraps its panel, not merely that a boundary
// component exists.
//
// Its own file because the mock below makes one screen throw, and that has to
// stay out of the other App tests' way (vitest's module registry is per-file).
//
// Why it exists at all: the first version of this fix was guarded by two tests
// that rendered `PanelBoundary` directly. Both passed with the shell no longer
// using it — unwrapping `<TabContent>` in App.tsx failed nothing. That is the
// same hole a reviewer found in the Signals legend tripwire: the mechanism was
// asserted, the HOOK-UP was not. So this test throws from inside a real tab and
// asserts what the operator would still have.

import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { RuntimeConfig } from './config';
import { useUiStore } from './store/uiStore';
import { jsonResponse, renderWithClient } from './test/renderWithClient';

// One screen that throws during render — the shape a malformed payload takes
// by the time it reaches React (E-23: a non-string topic name threw inside the
// row sort, and the throw escaped all the way to the root boundary).
vi.mock('./v2/monitor/MonitorScreen', () => ({
  MonitorScreen: () => {
    throw new Error('malformed payload reached render');
  },
}));

const STUB_CONFIG: RuntimeConfig = {
  endpoints: { api: '/api/v1', events: '/api/v1/events', webrtc: 'http://localhost:8002' },
  tabs: [],
  defaults: { ros_domain_id: 42 },
  schemas: {},
};

class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  close = vi.fn();
  constructor(public url: string) {}
}

beforeEach(() => {
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/config')) return Promise.resolve(jsonResponse(STUB_CONFIG)) as Promise<Response>;
    return Promise.resolve(jsonResponse({})) as Promise<Response>;
  });
  useUiStore.setState({ activeTab: '', sseStatus: 'closed' });
  // React logs the caught error; the boundary is the behaviour under test.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  window.history.replaceState(null, '', '/?tab=monitor');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

test('a throwing screen costs the panel; the tab bar and the other tabs survive', async () => {
  const { App } = await import('./App');
  renderWithClient(<App />);

  // The panel took it...
  expect(await screen.findByTestId('panel-error')).toHaveTextContent(/malformed payload/);
  // ...and the console did not. This is the assertion that fails if the shell
  // stops wrapping TabContent: the throw would reach the ROOT boundary, which
  // replaces the whole document — measured in chromium as the tab bar
  // disappearing and the operator being unable to leave the tab.
  expect(screen.getByRole('tablist')).toBeInTheDocument();
  expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  expect(screen.getByRole('tab', { name: 'Collect' })).toBeInTheDocument();
});

test('leaving the broken tab clears it — recovery costs a click, not a reload', async () => {
  const { App } = await import('./App');
  renderWithClient(<App />);
  await screen.findByTestId('panel-error');

  screen.getByRole('tab', { name: 'Collect' }).click();

  await waitFor(() =>
    expect(screen.queryByTestId('panel-error')).not.toBeInTheDocument(),
  );
  expect(screen.getByRole('tab', { name: 'Collect' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});
