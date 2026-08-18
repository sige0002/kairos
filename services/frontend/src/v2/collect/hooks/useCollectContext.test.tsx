// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../../api/client';
import { jsonResponse } from '../../../test/renderWithClient';
import {
  __rehydrateBatchStore,
  __resetBatchStore,
  dispatch,
  getStoreSnapshot,
} from '../machine/store';
import { useCollectContext } from './useCollectContext';

const BATCH_STORAGE_KEY = 'kairos.collect.batch';

function seedBatch({
  batchId = 'batch-a',
  recordedCount = 0,
  project = 'Tabletop Manipulation',
  task = 'Pick and Place',
  condition = 'Object: Left → Tray: Center',
}: {
  batchId?: string | null;
  recordedCount?: number;
  project?: string | null;
  task?: string | null;
  condition?: string;
} = {}) {
  window.localStorage.setItem(
    BATCH_STORAGE_KEY,
    JSON.stringify({
      batchId,
      batchSeq: 4,
      recordedCount,
      targetEpisodes: 30,
      episodes: [],
      project,
      task,
      condition,
      lastCaptureId: null,
    }),
  );
  __rehydrateBatchStore();
}

function renderContext() {
  const showToast = vi.fn();
  const setProjPickerOpen = vi.fn();
  const setTaskPickerOpen = vi.fn();
  const setCondModalOpen = vi.fn();
  const snapshot = getStoreSnapshot();
  const hook = renderHook(() =>
    useCollectContext({
      ctxEditable: true,
      project: snapshot.project,
      task: snapshot.task,
      batchId: snapshot.batchId,
      showToast,
      setProjPickerOpen,
      setTaskPickerOpen,
      setCondModalOpen,
    }),
  );
  return { ...hook, showToast, setProjPickerOpen, setTaskPickerOpen, setCondModalOpen };
}

function patchBody(call: unknown): unknown {
  const [, init] = call as [string, RequestInit];
  return JSON.parse(String(init.body));
}

beforeEach(() => {
  setApiBase('/api/v1');
  __resetBatchStore();
});

afterEach(() => vi.restoreAllMocks());

test('empty-batch relabel commits and closes its picker only after PATCH succeeds', async () => {
  seedBatch();
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}));
  const { result, setCondModalOpen, showToast } = renderContext();

  await act(async () => {
    await result.current.pickCondition('Object: Center → Tray: Center');
  });

  expect(fetchSpy).toHaveBeenCalledTimes(1);
  expect(patchBody(fetchSpy.mock.calls[0])).toEqual({
    condition: 'Object: Center → Tray: Center',
  });
  expect(getStoreSnapshot().condition).toBe('Object: Center → Tray: Center');
  expect(setCondModalOpen).toHaveBeenCalledWith(false);
  expect(showToast).toHaveBeenCalledWith('Condition updated');
});

test('a failed empty-batch relabel keeps local context and picker open for retry', async () => {
  seedBatch();
  const fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      jsonResponse(
        { error: { code: 'service_unavailable', message: 'try later' } },
        503,
      ),
    )
    .mockResolvedValueOnce(jsonResponse({}));
  const { result, setCondModalOpen, showToast } = renderContext();

  await act(async () => {
    await result.current.pickCondition('Object: Center → Tray: Center');
  });

  expect(getStoreSnapshot().condition).toBe('Object: Left → Tray: Center');
  expect(setCondModalOpen).not.toHaveBeenCalled();
  expect(showToast).toHaveBeenLastCalledWith(
    expect.stringContaining('current context was kept. Retry the change.'),
  );

  await act(async () => {
    await result.current.pickCondition('Object: Center → Tray: Center');
  });
  expect(fetchSpy).toHaveBeenCalledTimes(2);
  expect(getStoreSnapshot().condition).toBe('Object: Center → Tray: Center');
  expect(setCondModalOpen).toHaveBeenCalledWith(false);
});

test('a batchless local draft applies immediately without a PATCH', async () => {
  seedBatch({ batchId: null });
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  const { result, setCondModalOpen, showToast } = renderContext();

  await act(async () => {
    await result.current.pickCondition('Object: Center → Tray: Center');
  });

  expect(fetchSpy).not.toHaveBeenCalled();
  expect(getStoreSnapshot().condition).toBe('Object: Center → Tray: Center');
  expect(setCondModalOpen).toHaveBeenCalledWith(false);
  expect(showToast).toHaveBeenCalledWith('Condition updated');
});

test('an active recorded batch rolls over only after its terminal PATCH succeeds', async () => {
  seedBatch({ recordedCount: 1 });
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}));
  const { result, setCondModalOpen, showToast } = renderContext();

  await act(async () => {
    await result.current.pickCondition('Object: Center → Tray: Center');
  });

  expect(patchBody(fetchSpy.mock.calls[0])).toEqual({
    status: 'ended_early',
    ended_reason: 'Condition change',
  });
  expect(getStoreSnapshot()).toMatchObject({
    batchId: null,
    recordedCount: 0,
    condition: 'Object: Center → Tray: Center',
  });
  expect(setCondModalOpen).toHaveBeenCalledWith(false);
  expect(showToast).toHaveBeenCalledWith(
    'Set #4 closed (condition changed) — next recording starts a new set',
  );
});

test('a failed rollover PATCH preserves the old batch and context for retry', async () => {
  seedBatch({ recordedCount: 1 });
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    jsonResponse({ error: { code: 'service_unavailable', message: 'try later' } }, 503),
  );
  const { result, setCondModalOpen, showToast } = renderContext();

  await act(async () => {
    await result.current.pickCondition('Object: Center → Tray: Center');
  });

  expect(getStoreSnapshot()).toMatchObject({
    batchId: 'batch-a',
    recordedCount: 1,
    condition: 'Object: Left → Tray: Center',
  });
  expect(setCondModalOpen).not.toHaveBeenCalled();
  expect(showToast).toHaveBeenLastCalledWith(
    expect.stringContaining('current context was kept. Retry the change.'),
  );
});

test('an already-terminal batch rolls over locally without rewriting its status', async () => {
  seedBatch({ recordedCount: 1 });
  dispatch({ type: 'PICK_END_REASON', reason: 'done' });
  dispatch({ type: 'CONFIRM_END_BATCH' });
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  const { result } = renderContext();

  await act(async () => {
    await result.current.pickCondition('Object: Center → Tray: Center');
  });

  expect(fetchSpy).not.toHaveBeenCalled();
  expect(getStoreSnapshot()).toMatchObject({
    batchId: null,
    recordedCount: 0,
    condition: 'Object: Center → Tray: Center',
  });
});

test('a custom task explicitly clears an empty batch condition', async () => {
  seedBatch();
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}));
  const { result, setTaskPickerOpen } = renderContext();

  await act(async () => {
    await result.current.pickCustomTask('Fold the towel');
  });

  expect(patchBody(fetchSpy.mock.calls[0])).toEqual({
    task: 'Fold the towel',
    condition: null,
  });
  expect(getStoreSnapshot()).toMatchObject({ task: 'Fold the towel', condition: '—' });
  expect(setTaskPickerOpen).toHaveBeenCalledWith(false);
});

test('a second picker action is ignored while the first PATCH is unresolved', async () => {
  seedBatch();
  let resolvePatch: (response: Response) => void = () => {};
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        resolvePatch = resolve;
      }),
  );
  const { result } = renderContext();

  let first: Promise<void> = Promise.resolve();
  act(() => {
    first = result.current.pickCondition('Object: Center → Tray: Center');
    void result.current.pickCondition('Object: Right → Tray: Center');
  });
  expect(fetchSpy).toHaveBeenCalledTimes(1);

  await act(async () => {
    resolvePatch(jsonResponse({}));
    await first;
  });
  expect(getStoreSnapshot().condition).toBe('Object: Center → Tray: Center');
});
