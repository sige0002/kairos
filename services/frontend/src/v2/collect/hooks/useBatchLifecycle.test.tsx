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
  return (
    <QueryClientProvider client={makeTestClient()}>{children}</QueryClientProvider>
  );
}

function wrapperWithActiveRobot({ children }: { children: ReactNode }) {
  const client = makeTestClient();
  client.setQueryData(['config', 'options'], {
    active_robot: 'robot-a',
    robots: [],
    aspects: {},
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
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
      return Promise.resolve(
        jsonResponse({ active_robot: 'robot-a', robots: [], aspects: {} }),
      );
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
    return (
      parsed.pathname.endsWith('/batches') &&
      parsed.searchParams.get('status') === 'active'
    );
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
      return Promise.resolve(
        jsonResponse({ active_robot: 'robot-a', robots: [], aspects: {} }),
      );
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
  await waitFor(() =>
    expect(urls.some((url) => url.includes('/config/options'))).toBe(true),
  );
  expect(
    urls.some((url) =>
      new URL(url, window.location.origin).pathname.endsWith('/batches'),
    ),
  ).toBe(false);

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
      return Promise.resolve(
        jsonResponse({ active_robot: 'robot-a', robots: [], aspects: {} }),
      );
    }
    if (url.includes('/batches/finished-local')) {
      return Promise.resolve(
        jsonResponse({
          ...activeBatch('finished-local'),
          status: 'completed',
          captures: [],
        }),
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
      return Promise.resolve(
        jsonResponse({ active_robot: 'robot-a', robots: [], aspects: {} }),
      );
    }
    if (/\/batches\/[^?]+$/.test(url)) detailRequests.push(url);
    if (url.includes('/batches')) {
      const parsed = new URL(url, window.location.origin);
      if (parsed.searchParams.get('status') === 'active') {
        return Promise.resolve(
          jsonResponse({ items: [activeBatch('batch-a'), activeBatch('batch-b')] }),
        );
      }
      return Promise.resolve(jsonResponse({ items: [] }));
    }
    return Promise.resolve(jsonResponse({}));
  });

  renderHook(() => useBatchLifecycle(), { wrapper });

  await waitFor(() =>
    expect(useUiStore.getState().batchRestoreIssue).toBe('ambiguous'),
  );
  expect(getStoreSnapshot().batchId).toBeNull();
  expect(detailRequests).toEqual([]);
});

test('rolls over a recorded batch when the operator identity changes before Start', async () => {
  window.localStorage.setItem(
    BATCH_STORAGE_KEY,
    JSON.stringify({
      batchSeq: 4,
      recordedCount: 1,
      batchId: 'batch-old',
      episodes: [{ index: 1, quality: 'good', taskResult: 'ok' }],
      project: 'Project',
      task: 'Task',
      condition: 'Condition',
    }),
  );
  __rehydrateBatchStore();
  useUiStore.setState({ recordOperator: 'operator-b' });
  const calls: { url: string; method: string; body?: Record<string, unknown> }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    calls.push({ url, method, body });
    if (url.includes('/config/options')) {
      return Promise.resolve(
        jsonResponse({ active_robot: 'robot-a', robots: [], aspects: {} }),
      );
    }
    if (url.includes('/batches/batch-old') && method === 'GET') {
      return Promise.resolve(
        jsonResponse({
          ...activeBatch('batch-old'),
          operator: 'operator-a',
          episodes_recorded: 1,
          episode_count: 1,
          captures: [{ capture_id: 'cap-old' }],
        }),
      );
    }
    if (url.includes('/batches/batch-old') && method === 'PATCH') {
      return Promise.resolve(
        jsonResponse({ batch_id: 'batch-old', status: 'ended_early' }),
      );
    }
    if (url.endsWith('/batches') && method === 'POST') {
      return Promise.resolve(
        jsonResponse({ batch_id: 'batch-new', batch_seq: 5, status: 'active' }),
      );
    }
    if (url.includes('/batches')) return Promise.resolve(jsonResponse({ items: [] }));
    return Promise.resolve(jsonResponse({}));
  });

  const { result } = renderHook(() => useBatchLifecycle(), {
    wrapper: wrapperWithActiveRobot,
  });
  let batchId: string | null = null;
  await act(async () => {
    batchId = await result.current.ensureBatch();
  });

  expect(batchId).toBe('batch-new');
  expect(
    calls.find((c) => c.url.includes('/batches/batch-old') && c.method === 'PATCH')
      ?.body,
  ).toEqual({
    status: 'ended_early',
    ended_reason: 'identity change',
  });
  expect(
    calls.find((c) => c.url.endsWith('/batches') && c.method === 'POST')?.body,
  ).toMatchObject({
    robot: 'robot-a',
    operator: 'operator-b',
    project: 'Project',
    task: 'Task',
    condition: 'Condition',
  });
});

test('does not overwrite an empty batch robot while the active robot is unresolved', async () => {
  window.localStorage.setItem(
    BATCH_STORAGE_KEY,
    JSON.stringify({
      batchSeq: 4,
      recordedCount: 0,
      batchId: 'batch-empty',
      episodes: [],
      project: 'Project',
      task: 'Task',
      condition: 'Condition',
    }),
  );
  __rehydrateBatchStore();
  const pendingOptions = new Promise<Response>(() => {});
  const calls: { url: string; method: string }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url, method });
    if (url.includes('/config/options')) return pendingOptions;
    if (url.includes('/batches/batch-empty') && method === 'GET') {
      return Promise.resolve(
        jsonResponse({ ...activeBatch('batch-empty'), captures: [] }),
      );
    }
    return Promise.resolve(jsonResponse({ items: [] }));
  });

  const { result } = renderHook(() => useBatchLifecycle(), { wrapper });
  let batchId: string | null = null;
  await act(async () => {
    batchId = await result.current.ensureBatch();
  });

  expect(batchId).toBe('batch-empty');
  expect(
    calls.some((c) => c.url.includes('/batches/batch-empty') && c.method === 'PATCH'),
  ).toBe(false);
});

test('relabels an empty active batch when its remote collection context differs', async () => {
  window.localStorage.setItem(
    BATCH_STORAGE_KEY,
    JSON.stringify({
      batchSeq: 4,
      recordedCount: 0,
      batchId: 'batch-empty-context',
      episodes: [],
      project: 'Project',
      task: 'Task',
      condition: 'Condition',
    }),
  );
  __rehydrateBatchStore();
  const calls: { url: string; method: string; body?: Record<string, unknown> }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    calls.push({ url, method, body });
    if (url.includes('/batches/batch-empty-context') && method === 'GET') {
      return Promise.resolve(
        jsonResponse({
          ...activeBatch('batch-empty-context'),
          condition: 'Remote condition',
          captures: [],
        }),
      );
    }
    if (url.includes('/batches/batch-empty-context') && method === 'PATCH') {
      return Promise.resolve(
        jsonResponse({
          ...activeBatch('batch-empty-context'),
          batch_seq: 4,
          status: 'active',
        }),
      );
    }
    return Promise.resolve(jsonResponse({ items: [] }));
  });

  const { result } = renderHook(() => useBatchLifecycle(), {
    wrapper: wrapperWithActiveRobot,
  });
  let batchId: string | null = null;
  await act(async () => {
    batchId = await result.current.ensureBatch();
  });

  expect(batchId).toBe('batch-empty-context');
  expect(
    calls.find(
      (call) =>
        call.url.includes('/batches/batch-empty-context') && call.method === 'PATCH',
    )?.body,
  ).toEqual({
    robot: 'robot-a',
    operator: 'operator-a',
    project_id: null,
    task_id: null,
    condition_id: null,
    project: 'Project',
    task: 'Task',
    condition: 'Condition',
  });
});

test('rolls over a recorded batch when the active robot changes before Start', async () => {
  window.localStorage.setItem(
    BATCH_STORAGE_KEY,
    JSON.stringify({
      batchSeq: 4,
      recordedCount: 1,
      batchId: 'batch-old-robot',
      episodes: [{ index: 1, quality: 'good', taskResult: 'ok' }],
      project: 'Project',
      task: 'Task',
      condition: 'Condition',
    }),
  );
  __rehydrateBatchStore();
  const calls: { url: string; method: string; body?: Record<string, unknown> }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    calls.push({ url, method, body });
    if (url.includes('/batches/batch-old-robot') && method === 'GET') {
      return Promise.resolve(
        jsonResponse({
          ...activeBatch('batch-old-robot'),
          robot: 'robot-old',
          episodes_recorded: 1,
          episode_count: 1,
          captures: [{ capture_id: 'cap-old' }],
        }),
      );
    }
    if (url.includes('/batches/batch-old-robot') && method === 'PATCH') {
      return Promise.resolve(
        jsonResponse({ batch_id: 'batch-old-robot', status: 'ended_early' }),
      );
    }
    if (url.endsWith('/batches') && method === 'POST') {
      return Promise.resolve(
        jsonResponse({ batch_id: 'batch-robot-new', batch_seq: 5, status: 'active' }),
      );
    }
    if (url.includes('/batches')) return Promise.resolve(jsonResponse({ items: [] }));
    return Promise.resolve(jsonResponse({}));
  });

  const { result } = renderHook(() => useBatchLifecycle(), {
    wrapper: wrapperWithActiveRobot,
  });
  let batchId: string | null = null;
  await act(async () => {
    batchId = await result.current.ensureBatch();
  });

  expect(batchId).toBe('batch-robot-new');
  expect(
    calls.find(
      (c) => c.url.includes('/batches/batch-old-robot') && c.method === 'PATCH',
    )?.body,
  ).toEqual({ status: 'ended_early', ended_reason: 'identity change' });
  expect(
    calls.find((c) => c.url.endsWith('/batches') && c.method === 'POST')?.body,
  ).toMatchObject({ robot: 'robot-a', operator: 'operator-a' });
});
