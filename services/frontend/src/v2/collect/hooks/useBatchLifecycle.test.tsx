// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki

import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../../api/client';
import { jsonResponse, makeTestClient } from '../../../test/renderWithClient';
import { useUiStore } from '../../../store/uiStore';
import {
  __rehydrateBatchStore,
  __resetBatchStore,
  getStoreSnapshot,
} from '../machine/store';
import { useBatchLifecycle } from './useBatchLifecycle';

const BATCH_STORAGE_KEY = 'kairos.collect.batch';

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={makeTestClient()}>{children}</QueryClientProvider>;
}

function activeBatch(id: string) {
  return {
    batch_id: id,
    robot: 'robot-a',
    operator: 'operator-a',
    project: 'Project',
    task: 'Task',
    condition: 'Condition',
    target_episodes: 30,
    status: 'active',
    episode_count: 0,
  };
}

beforeEach(() => {
  setApiBase('/api/v1');
  __resetBatchStore();
  useUiStore.setState({
    recordOperator: 'operator-a',
    operatorHydrated: true,
    batchRestoreIssue: null,
  });
});

afterEach(() => vi.restoreAllMocks());

test('restores only through the active robot/operator filter', async () => {
  const urls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    urls.push(url);
    if (url.includes('/config/options')) {
      return Promise.resolve(jsonResponse({ active_robot: 'robot-a', robots: [], aspects: {} }));
    }
    if (url.includes('/batches/batch-a')) {
      return Promise.resolve(jsonResponse({ ...activeBatch('batch-a'), captures: [] }));
    }
    if (url.includes('/batches')) {
      const parsed = new URL(url, window.location.origin);
      if (parsed.searchParams.get('status') === 'active') {
        return Promise.resolve(jsonResponse({ items: [activeBatch('batch-a')] }));
      }
      return Promise.resolve(jsonResponse({ items: [] }));
    }
    return Promise.resolve(jsonResponse({}));
  });

  renderHook(() => useBatchLifecycle(), { wrapper });

  await waitFor(() => expect(getStoreSnapshot().batchId).toBe('batch-a'));
  const restore = urls.find((url) => {
    const parsed = new URL(url, window.location.origin);
    return parsed.pathname.endsWith('/batches') && parsed.searchParams.get('status') === 'active';
  });
  const query = new URL(restore!, window.location.origin).searchParams;
  expect(query.get('robot')).toBe('robot-a');
  expect(query.get('operator')).toBe('operator-a');
});

test('waits for operator hydration before sending a filtered restore request', async () => {
  const urls: string[] = [];
  useUiStore.setState({ operatorHydrated: false });
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    urls.push(url);
    if (url.includes('/config/options')) {
      return Promise.resolve(jsonResponse({ active_robot: 'robot-a', robots: [], aspects: {} }));
    }
    if (url.includes('/batches/batch-a')) {
      return Promise.resolve(jsonResponse({ ...activeBatch('batch-a'), captures: [] }));
    }
    if (url.includes('/batches')) {
      const parsed = new URL(url, window.location.origin);
      return Promise.resolve(
        jsonResponse({
          items:
            parsed.searchParams.get('status') === 'active'
              ? [activeBatch('batch-a')]
              : [],
        }),
      );
    }
    return Promise.resolve(jsonResponse({}));
  });

  renderHook(() => useBatchLifecycle(), { wrapper });
  await waitFor(() => expect(urls.some((url) => url.includes('/config/options'))).toBe(true));
  expect(urls.some((url) => new URL(url, window.location.origin).pathname.endsWith('/batches'))).toBe(false);

  act(() => useUiStore.getState().hydrateRecordOperator('operator-a'));
  await waitFor(() => expect(getStoreSnapshot().batchId).toBe('batch-a'));
  expect(
    urls.some((url) => {
      const parsed = new URL(url, window.location.origin);
      return (
        parsed.pathname.endsWith('/batches') &&
        parsed.searchParams.get('status') === 'active' &&
        parsed.searchParams.get('robot') === 'robot-a' &&
        parsed.searchParams.get('operator') === 'operator-a'
      );
    }),
  ).toBe(true);
});

test('zero filtered active batches leaves a local batch unchanged', async () => {
  window.localStorage.setItem(
    BATCH_STORAGE_KEY,
    JSON.stringify({
      batchSeq: 4,
      recordedCount: 1,
      batchId: 'finished-local',
      episodes: [],
      project: 'Project',
      task: 'Task',
      condition: 'Condition',
    }),
  );
  __rehydrateBatchStore();
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/config/options')) {
      return Promise.resolve(jsonResponse({ active_robot: 'robot-a', robots: [], aspects: {} }));
    }
    if (url.includes('/batches/finished-local')) {
      return Promise.resolve(
        jsonResponse({ ...activeBatch('finished-local'), status: 'completed', captures: [] }),
      );
    }
    if (url.includes('/batches')) return Promise.resolve(jsonResponse({ items: [] }));
    return Promise.resolve(jsonResponse({}));
  });

  renderHook(() => useBatchLifecycle(), { wrapper });

  await waitFor(() => expect(getStoreSnapshot().predictedSeq).toBe(1));
  expect(getStoreSnapshot().batchId).toBe('finished-local');
  expect(getStoreSnapshot().batchSeq).toBe(4);
});

test('multiple active matches are refused and made visible to the shell', async () => {
  const detailRequests: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/config/options')) {
      return Promise.resolve(jsonResponse({ active_robot: 'robot-a', robots: [], aspects: {} }));
    }
    if (/\/batches\/[^?]+$/.test(url)) detailRequests.push(url);
    if (url.includes('/batches')) {
      const parsed = new URL(url, window.location.origin);
      if (parsed.searchParams.get('status') === 'active') {
        return Promise.resolve(jsonResponse({ items: [activeBatch('batch-a'), activeBatch('batch-b')] }));
      }
      return Promise.resolve(jsonResponse({ items: [] }));
    }
    return Promise.resolve(jsonResponse({}));
  });

  renderHook(() => useBatchLifecycle(), { wrapper });

  await waitFor(() => expect(useUiStore.getState().batchRestoreIssue).toBe('ambiguous'));
  expect(getStoreSnapshot().batchId).toBeNull();
  expect(detailRequests).toEqual([]);
});
