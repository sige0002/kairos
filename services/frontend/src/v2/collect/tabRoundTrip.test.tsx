// E-28, the Collect half: what a tab round-trip does to a LIVE take.
//
// The shell unmounts the screen on a tab switch and mounts a fresh one on the
// way back, and the batch machine deliberately survives that in a module-level
// store — episodes, phase and the current capture are all already pinned
// against it (useBatchMachine.test.tsx, "confirmed episodes survive an
// unmount/remount"). What was never pinned is the RECORDING itself: an operator
// who steps over to Monitor to check a topic and comes back is the ordinary
// way this screen is used mid-take.
//
// Existing coverage checked before writing anything here: the unmount/remount
// tests cover a confirmed episode's count and the result phase + its capture.
// The `?tab=` history navigation and the shortcut layer's overlay/typing guards
// are covered in App.test.tsx and KeyboardFlow.test.tsx respectively. Only the
// live-take round-trip is new.

import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';
import { setApiBase } from '../../api/client';
import { makeTestClient, jsonResponse } from '../../test/renderWithClient';
import { useUiStore } from '../../store/uiStore';
import {
  useBatchMachine,
  __resetBatchStore,
  __setStopFloorMs,
} from './useBatchMachine';

const CAP = 'cap_roundtrip';

function wrapper({ children }: { children: ReactNode }) {
  const client = makeTestClient();
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function mockRecorder(): void {
  let started = false;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/record/status')) {
      return Promise.resolve(
        jsonResponse(
          started
            ? {
                capture_id: CAP,
                run_id: 'run_roundtrip',
                state: 'recording',
                live_capture_ids: [CAP],
                started_at: '2026-08-01T00:00:00.000Z',
              }
            : {
                capture_id: null,
                run_id: null,
                state: 'created',
                live_capture_ids: [],
              },
        ),
      );
    }
    if (url.includes('/record/start')) {
      started = true;
      return Promise.resolve(
        jsonResponse({
          capture_id: CAP,
          run_id: 'run_roundtrip',
          state: 'recording',
          review_status: 'pending',
          review_revision: 0,
        }),
      );
    }
    return Promise.resolve(jsonResponse({}));
  });
}

beforeEach(() => {
  setApiBase('/api/v1');
  __setStopFloorMs(0);
  __resetBatchStore();
  useUiStore.setState({
    activeTab: '',
    recordOperator: '',
    recordSelected: new Set<string>(),
    recordCustomized: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test('E-28: a tab round-trip mid-take does not restart the elapsed clock', async () => {
  mockRecorder();
  const first = renderHook(() => useBatchMachine({ defaultTopics: [] }), { wrapper });

  act(() => first.result.current.startRecording());
  await waitFor(() => expect(first.result.current.phase).toBe('recording'));
  // Let the take get old enough that a restart is unmistakable.
  await waitFor(() => expect(first.result.current.elapsedMs).toBeGreaterThan(1000), {
    timeout: 4000,
  });
  const beforeSwitch = first.result.current.elapsedMs;

  // The tab switch: this screen unmounts, a fresh one mounts on the way back.
  first.unmount();
  const second = renderHook(() => useBatchMachine({ defaultTopics: [] }), { wrapper });

  // The take never stopped, so its age did not go back to zero. A recording
  // reading 00:00:00 is indistinguishable from one that just started — and from
  // one that died and was restarted, which is what an operator returning to the
  // tab would reasonably conclude.
  expect(second.result.current.phase).toBe('recording');
  // Wait for a tick produced by the REMOUNTED screen. The store still holds the
  // pre-switch figure, so asserting before that tick lands passes no matter what
  // the remount did to the baseline.
  await waitFor(() => expect(second.result.current.elapsedMs).not.toBe(beforeSwitch), {
    timeout: 4000,
  });
  expect(second.result.current.elapsedMs).toBeGreaterThanOrEqual(beforeSwitch);
});

// The same baseline feeds the Stop floor, so losing it on a tab switch costs
// the operator more than a display: the floor asks how old the take is, and a
// take that has been running for a minute is not a double-click. Coming back to
// the tab must not disable Stop all over again.
test('E-28: a tab round-trip mid-take does not re-arm the Stop floor', async () => {
  __setStopFloorMs(1000);
  mockRecorder();
  const first = renderHook(() => useBatchMachine({ defaultTopics: [] }), { wrapper });

  act(() => first.result.current.startRecording());
  await waitFor(() => expect(first.result.current.phase).toBe('recording'));
  // Positive control: the floor is a real gate here, and this take has cleared it.
  expect(first.result.current.canStop).toBe(false);
  await waitFor(() => expect(first.result.current.canStop).toBe(true), {
    timeout: 4000,
  });

  first.unmount();
  const second = renderHook(() => useBatchMachine({ defaultTopics: [] }), { wrapper });

  expect(second.result.current.phase).toBe('recording');
  expect(second.result.current.canStop).toBe(true);
});
