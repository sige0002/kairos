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

function mockHealth(answer: () => Promise<Response>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    if (String(input).includes('/store/health')) return answer();
    return Promise.resolve(jsonResponse({}));
  });
}

beforeEach(() => {
  setApiBase('/api/v1');
  useUiStore.setState({ activeTab: 'collect' });
  window.history.replaceState(null, '', '/?tab=collect');
});

afterEach(() => {
  vi.restoreAllMocks();
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

  expect(screen.getByTestId('store-health-banner')).toHaveAttribute('data-state', 'loading');
  expect(screen.getByText('Checking store health…')).toBeInTheDocument();
});

test('states that an error is unavailable and permits an explicit retry', async () => {
  let attempts = 0;
  const fetchSpy = mockHealth(() => {
    attempts += 1;
    return Promise.resolve(attempts === 1 ? jsonResponse({ error: { message: 'offline' } }, 503) : jsonResponse(OK));
  });
  renderWithClient(<StoreHealthBanner />);

  const banner = await screen.findByTestId('store-health-banner');
  await waitFor(() => expect(banner).toHaveAttribute('data-state', 'unavailable'));
  expect(banner).toHaveTextContent('this is not an all-clear');
  fireEvent.click(screen.getByTestId('store-health-banner-retry'));
  await waitFor(() => expect(screen.queryByTestId('store-health-banner')).toBeNull());
  expect(fetchSpy.mock.calls.filter(([input]) => String(input).includes('/store/health'))).toHaveLength(2);
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
