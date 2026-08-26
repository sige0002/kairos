// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import type { StoreHealth } from '../../api/types';
import { useUiStore } from '../../store/uiStore';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { StoreHealthBanner } from './StoreHealthBanner';

const OK: StoreHealth = {
  instance_id: 'pc-01',
  state: 'ok',
  delete_available: true,
  corrupt: [],
  warnings: [],
};

const INFORMATIONAL: StoreHealth = {
  ...OK,
  rebuilt_at: '2026-08-26T08:00:00Z',
  warnings: ['Batch counters were rebuilt as lower bounds.'],
};

function mockHealth(answer: () => Promise<Response>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    if (String(input).includes('/store/health')) return answer();
    return Promise.resolve(jsonResponse({}));
  });
}

beforeEach(() => {
  localStorage.clear();
  setApiBase('/api/v1');
  useUiStore.setState({ activeTab: 'collect' });
  window.history.replaceState(null, '', '/?tab=collect');
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

test('hides the global notice only after an explicit healthy response', async () => {
  mockHealth(() => Promise.resolve(jsonResponse(OK)));
  renderWithClient(<StoreHealthBanner />);

  await waitFor(() => expect(screen.queryByTestId('store-health-banner')).toBeNull());
});

test('shows Checking while the health request is unresolved', () => {
  mockHealth(() => new Promise<Response>(() => undefined));
  renderWithClient(<StoreHealthBanner />);

  expect(screen.getByTestId('store-health-banner')).toHaveAttribute(
    'data-state',
    'loading',
  );
  expect(screen.getByText('Checking store health…')).toBeInTheDocument();
});

test('states that an error is unavailable and permits an explicit retry', async () => {
  let attempts = 0;
  const fetchSpy = mockHealth(() => {
    attempts += 1;
    return Promise.resolve(
      attempts === 1
        ? jsonResponse({ error: { message: 'offline' } }, 503)
        : jsonResponse(OK),
    );
  });
  renderWithClient(<StoreHealthBanner />);

  const banner = await screen.findByTestId('store-health-banner');
  await waitFor(() => expect(banner).toHaveAttribute('data-state', 'unavailable'));
  expect(banner).toHaveTextContent('this is not an all-clear');
  fireEvent.click(screen.getByTestId('store-health-banner-retry'));
  await waitFor(() => expect(screen.queryByTestId('store-health-banner')).toBeNull());
  expect(
    fetchSpy.mock.calls.filter(([input]) => String(input).includes('/store/health')),
  ).toHaveLength(2);
});

test('makes suspect cleanup halt visible and links the main window to Monitor Store', async () => {
  mockHealth(() =>
    Promise.resolve(
      jsonResponse({
        ...OK,
        state: 'suspect',
        suspect_reason: 'Too many replicas disappeared.',
      }),
    ),
  );
  renderWithClient(<StoreHealthBanner />);

  const banner = await screen.findByTestId('store-health-banner');
  await waitFor(() => expect(banner).toHaveAttribute('data-state', 'suspect'));
  expect(banner).toHaveTextContent('automatic cleanup is halted');
  fireEvent.click(screen.getByTestId('store-health-banner-monitor'));
  expect(useUiStore.getState().activeTab).toBe('monitor');
  const route = new URLSearchParams(window.location.search);
  expect(route.get('tab')).toBe('monitor');
  expect(route.get('view')).toBe('store');
});

test('shows corrupt or warning evidence and directs a solo window to Monitor Store', async () => {
  mockHealth(() =>
    Promise.resolve(
      jsonResponse({
        ...OK,
        corrupt: [{ path: 'objects/bad/record.json', reason: 'invalid json' }],
        corrupt_source: 'reconcile',
        warnings: ['One object is missing its manifest.'],
      }),
    ),
  );
  renderWithClient(<StoreHealthBanner solo />);

  const banner = await screen.findByTestId('store-health-banner');
  await waitFor(() => expect(banner).toHaveAttribute('data-state', 'warning'));
  expect(banner).toHaveTextContent('corrupt sidecar');
  expect(banner).toHaveTextContent('One object is missing its manifest.');
  fireEvent.click(screen.getByTestId('store-health-banner-monitor'));
  expect(window.location.search).toContain('tab=monitor');
  expect(window.location.search).toContain('solo=1');
  expect(window.location.search).toContain('view=store');
});

test('dismisses an informational rebuild notice without another API request', async () => {
  const fetchSpy = mockHealth(() => Promise.resolve(jsonResponse(INFORMATIONAL)));
  renderWithClient(<StoreHealthBanner />);

  const banner = await screen.findByTestId('store-health-banner');
  await waitFor(() => expect(banner).toHaveAttribute('data-state', 'warning'));
  expect(screen.getByTestId('store-health-banner-monitor')).toBeInTheDocument();
  fireEvent.click(screen.getByTestId('store-health-banner-dismiss'));

  await waitFor(() => expect(screen.queryByTestId('store-health-banner')).toBeNull());
  expect(
    fetchSpy.mock.calls.filter(([input]) => String(input).includes('/store/health')),
  ).toHaveLength(1);
});

test('keeps the same informational notice dismissed after remount', async () => {
  const fetchSpy = mockHealth(() => Promise.resolve(jsonResponse(INFORMATIONAL)));
  const first = renderWithClient(<StoreHealthBanner />);

  await screen.findByTestId('store-health-banner-dismiss');
  fireEvent.click(screen.getByTestId('store-health-banner-dismiss'));
  await waitFor(() => expect(screen.queryByTestId('store-health-banner')).toBeNull());
  first.unmount();

  renderWithClient(<StoreHealthBanner />);
  await waitFor(() => expect(screen.queryByTestId('store-health-banner')).toBeNull());
  expect(
    fetchSpy.mock.calls.filter(([input]) => String(input).includes('/store/health')),
  ).toHaveLength(2);
});

test('shows a later rebuild notice after the earlier one was dismissed', async () => {
  let health = INFORMATIONAL;
  mockHealth(() => Promise.resolve(jsonResponse(health)));
  const first = renderWithClient(<StoreHealthBanner />);

  await screen.findByTestId('store-health-banner-dismiss');
  fireEvent.click(screen.getByTestId('store-health-banner-dismiss'));
  await waitFor(() => expect(screen.queryByTestId('store-health-banner')).toBeNull());
  first.unmount();

  health = {
    ...INFORMATIONAL,
    rebuilt_at: '2026-08-26T09:00:00Z',
    warnings: ['A later rebuild produced a new lower-bound notice.'],
  };
  renderWithClient(<StoreHealthBanner />);

  const laterBanner = await screen.findByTestId('store-health-banner');
  await waitFor(() =>
    expect(laterBanner).toHaveTextContent(
      'A later rebuild produced a new lower-bound notice.',
    ),
  );
  expect(screen.getByTestId('store-health-banner-dismiss')).toBeInTheDocument();
});

test('does not offer dismissal without a trustworthy rebuild identity', async () => {
  mockHealth(() =>
    Promise.resolve(
      jsonResponse({
        ...INFORMATIONAL,
        rebuilt_at: null,
      }),
    ),
  );
  renderWithClient(<StoreHealthBanner />);

  expect(await screen.findByTestId('store-health-banner')).toBeInTheDocument();
  expect(screen.queryByTestId('store-health-banner-dismiss')).toBeNull();
});

test('keeps the notice visible when acknowledgement cannot be stored', async () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('storage unavailable');
  });
  mockHealth(() => Promise.resolve(jsonResponse(INFORMATIONAL)));
  renderWithClient(<StoreHealthBanner />);

  await screen.findByTestId('store-health-banner-dismiss');
  fireEvent.click(screen.getByTestId('store-health-banner-dismiss'));

  expect(screen.getByTestId('store-health-banner')).toBeInTheDocument();
});

test('keeps the notice visible when acknowledgement cannot be read', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('storage unavailable');
  });
  mockHealth(() => Promise.resolve(jsonResponse(INFORMATIONAL)));
  renderWithClient(<StoreHealthBanner />);

  expect(await screen.findByTestId('store-health-banner-dismiss')).toBeInTheDocument();
});

test.each<[string, StoreHealth, string]>([
  [
    'SUSPECT',
    {
      ...INFORMATIONAL,
      state: 'suspect',
      suspect_reason: 'Too many replicas disappeared.',
    },
    'automatic cleanup is halted',
  ],
  [
    'current corruption',
    {
      ...INFORMATIONAL,
      corrupt: [{ path: 'objects/bad/record.json', reason: 'invalid json' }],
    },
    'corrupt sidecar',
  ],
  [
    'delete unavailable',
    {
      ...INFORMATIONAL,
      delete_available: false,
      delete_unavailable_reason: 'Store directories are on different filesystems.',
    },
    'Store directories are on different filesystems.',
  ],
])('does not dismiss the active %s condition', async (_name, health, evidence) => {
  mockHealth(() => Promise.resolve(jsonResponse(health)));
  renderWithClient(<StoreHealthBanner />);

  const banner = await screen.findByTestId('store-health-banner');
  await waitFor(() => expect(banner).toHaveTextContent(evidence));
  expect(screen.queryByTestId('store-health-banner-dismiss')).toBeNull();
});
