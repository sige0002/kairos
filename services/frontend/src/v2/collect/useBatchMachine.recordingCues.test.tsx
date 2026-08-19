// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki

import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';
import { setApiBase } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import { jsonResponse, makeTestClient } from '../../test/renderWithClient';
import { useUiStore } from '../../store/uiStore';
import {
  __resetBatchStore,
  __setStopConfirmMs,
  __setStopFloorMs,
  useBatchMachine,
} from './useBatchMachine';

const cueHarness = vi.hoisted(() => ({
  played: [] as string[],
  unlock: vi.fn(async () => true),
  dispose: vi.fn(),
}));

vi.mock('./recordingCues', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./recordingCues')>();
  return {
    ...actual,
    createRecordingCuePlayer: () => ({
      supported: true,
      unlock: cueHarness.unlock,
      play: vi.fn(async (kind: string) => {
        cueHarness.played.push(kind);
        return true;
      }),
      dispose: cueHarness.dispose,
    }),
  };
});

function wrapper({ children }: { children: ReactNode }) {
  const client = makeTestClient();
  client.setQueryData(queryKeys.configOptions, {
    active_robot: 'test-robot',
    robots: [],
    aspects: {},
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function capture(captureId: string, state: 'recording' | 'completed' | 'failed') {
  return {
    capture_id: captureId,
    run_id: `run_${captureId}`,
    state,
    review_status: 'pending',
    review_revision: 0,
  };
}

beforeEach(() => {
  setApiBase('/api/v1');
  __resetBatchStore();
  __setStopFloorMs(0);
  __setStopConfirmMs(0, 1);
  cueHarness.played.length = 0;
  cueHarness.unlock.mockClear();
  cueHarness.dispose.mockClear();
  window.localStorage.setItem(
    'kairos.collect.recording-cues.v1',
    JSON.stringify({ enabled: true, volume: 0.45 }),
  );
  useUiStore.setState({
    recordOperator: 'tester',
    operatorHydrated: true,
    recordSelected: new Set<string>(),
    recordCustomized: false,
  });
});

afterEach(() => vi.restoreAllMocks());

test('the machine wires live-confirmed Start and confirmed Stop to their cues', async () => {
  let started = false;
  let stopped = false;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/record/start')) {
      started = true;
      return Promise.resolve(jsonResponse(capture('cap_sound', 'recording')));
    }
    if (url.includes('/record/stop')) {
      stopped = true;
      return Promise.resolve(jsonResponse(capture('cap_sound', 'completed')));
    }
    if (url.includes('/record/status')) {
      if (stopped)
        return Promise.resolve(
          jsonResponse({
            capture_id: 'cap_sound',
            state: 'completed',
            live_capture_ids: [],
            integrity: 'ok',
          }),
        );
      if (started)
        return Promise.resolve(
          jsonResponse({
            capture_id: 'cap_sound',
            state: 'recording',
            live_capture_ids: ['cap_sound'],
          }),
        );
      return Promise.resolve(jsonResponse({ state: 'created', live_capture_ids: [] }));
    }
    return Promise.resolve(jsonResponse({}));
  });

  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  act(() => result.current.startRecording());
  await waitFor(() => expect(cueHarness.played).toEqual(['start']));

  act(() => result.current.stopRecording());
  await waitFor(() => expect(cueHarness.played).toEqual(['start', 'end']));
});

test('a recorder-rejected Start is wired to the warning cue', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/record/start'))
      return Promise.resolve(jsonResponse(capture('cap_failed', 'failed')));
    if (url.includes('/record/status'))
      return Promise.resolve(jsonResponse({ state: 'created', live_capture_ids: [] }));
    return Promise.resolve(jsonResponse({}));
  });

  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  act(() => result.current.startRecording());
  await waitFor(() => expect(result.current.phase).toBe('ready'));
  expect(cueHarness.played).toEqual(['warning']);
});
