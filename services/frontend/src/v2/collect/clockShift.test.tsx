// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// E-32: the terminal's wall clock is not a stopwatch.
//
// A recording console runs for hours on a machine that may be stepped by NTP at
// any moment — a robot PC that just got its network back is the ordinary case,
// not the exotic one. The elapsed figure on the recording card is a DURATION
// measured entirely on this machine (baseline taken when the take begins, read
// again on every tick), so measuring it with `Date.now()` means an NTP step
// subtracts itself from the answer.
//
// WHY THAT IS THE VERDICT SENTENCE AND NOT A COSMETIC DRIFT. `formatElapsed`
// clamps at zero, so a backwards step does not render a negative number — it
// renders `00:00:00`, which is exactly what a take that has not started yet
// reads, and it STAYS there for as long as the step was large. The operator has
// no way to tell a running recording from a dead one by the only progress
// indicator on the card.
//
// The fix is to measure the duration on the monotonic clock (`performance.now`,
// which is unaffected by system-time changes) while leaving every SERVER-stamped
// time on the wall clock, where it belongs: `started_at` and the recorder's
// last-good timestamp come from another process, and comparing them to
// `performance.now()` would be meaningless.
//
// HOW THE ROLLBACK IS DRIVEN. `Date.now` is stubbed with a fixed offset while
// the real clock keeps running underneath, so the intervals in the hook fire on
// real time exactly as they do in a browser, and `performance.now()` is left
// completely alone. That is the shape of a real NTP step: one clock moves, the
// other does not.

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

const CAP = 'cap_clock_1';

function wrapper({ children }: { children: ReactNode }) {
  const client = makeTestClient();
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** Recorder that answers "recording" once this screen has started a take. */
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
                run_id: 'run_clock_1',
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
          run_id: 'run_clock_1',
          state: 'recording',
          review_status: 'pending',
          review_revision: 0,
        }),
      );
    }
    return Promise.resolve(jsonResponse({}));
  });
}

/** Recorder that stops answering the instant this screen starts a take. The
 *  start's own status invalidation is the poll that fails, so the card is
 *  unreachable within a render or two instead of a poll interval. */
function mockRecorderDyingAtStart(): void {
  let started = false;
  let alive = true;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/record/status')) {
      if (!alive) {
        return Promise.resolve(
          jsonResponse(
            { error: { code: 'recorder_unreachable', message: 'unreachable' } },
            503,
          ),
        );
      }
      return Promise.resolve(
        jsonResponse(
          started
            ? {
                capture_id: CAP,
                run_id: 'run_clock_1',
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
      alive = false;
      return Promise.resolve(
        jsonResponse({
          capture_id: CAP,
          run_id: 'run_clock_1',
          state: 'recording',
          review_status: 'pending',
          review_revision: 0,
        }),
      );
    }
    return Promise.resolve(jsonResponse({}));
  });
}

/** Step the system clock by *deltaMs* (negative = backwards) while the real
 *  clock — and `performance.now()` — keep running underneath. */
function stepSystemClock(deltaMs: number): void {
  const real = Date.now.bind(Date);
  vi.spyOn(Date, 'now').mockImplementation(() => real() + deltaMs);
}

beforeEach(() => {
  setApiBase('/api/v1');
  __setStopFloorMs(0);
  __resetBatchStore();
  useUiStore.setState({
    activeTab: '',
    // Recording requires an operator since #11, in every configuration —
    // so a suite that records has to say who is recording. The gate itself
    // is exercised where it is the subject, not incidentally here.
    recordOperator: 'tester',
    recordSelected: new Set<string>(),
    recordCustomized: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test('E-32: the elapsed clock survives an NTP step BACKWARDS mid-take', async () => {
  mockRecorder();
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });

  act(() => result.current.startRecording());
  await waitFor(() => expect(result.current.phase).toBe('recording'));

  // Positive control: this harness can see the clock RUN. Without it, a fix
  // that froze the timer outright would pass every assertion below.
  await waitFor(() => expect(result.current.elapsedMs).toBeGreaterThan(600), {
    timeout: 4000,
  });
  const beforeStep = result.current.elapsedMs;

  // NTP steps the terminal back one minute in the middle of the take.
  stepSystemClock(-60_000);

  // The take is still running, so its elapsed figure must still be climbing.
  await waitFor(() => expect(result.current.elapsedMs).toBeGreaterThan(beforeStep), {
    timeout: 4000,
  });
  // And it never passes through the value that means "nothing is recording".
  expect(result.current.elapsedMs).toBeGreaterThan(600);
}, 20000);

test('E-32: the elapsed clock survives an NTP step FORWARDS mid-take', async () => {
  mockRecorder();
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });

  act(() => result.current.startRecording());
  await waitFor(() => expect(result.current.phase).toBe('recording'));
  await waitFor(() => expect(result.current.elapsedMs).toBeGreaterThan(600), {
    timeout: 4000,
  });
  const beforeStep = result.current.elapsedMs;

  // The mirror case, and the one an operator is more likely to act on: a step
  // forwards makes a take that began seconds ago claim an hour of recording,
  // which reads as a take someone forgot to stop.
  stepSystemClock(60 * 60_000);

  // Wait for a tick that happened AFTER the step — asserting on a value that
  // predates it passes no matter what the step did.
  await waitFor(() => expect(result.current.elapsedMs).not.toBe(beforeStep), {
    timeout: 4000,
  });
  expect(result.current.elapsedMs).toBeLessThan(60_000);
}, 20000);

// The same clock, one card over. When the recorder stops answering the card
// keeps the last reading on screen and labels it with its age — "Last known:
// recording, 12s ago" — and that age is the whole reason the stale reading is
// safe to show. It is measured wall-clock-to-wall-clock (`Date.now()` minus
// react-query's `dataUpdatedAt`), so a backwards step drives it negative, the
// clamp turns that into `0`, and the card says the dead recorder answered just
// now. `useRecordStatus`'s own contract is 「読めなかった」を「異常なし」に見せない;
// a reading whose stated age resets to zero is exactly that presentation.
test('E-32: the "last known … Ns ago" age does not reset when the clock steps back', async () => {
  mockRecorderDyingAtStart();
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });

  act(() => result.current.startRecording());
  await waitFor(() => expect(result.current.recorderUnreachable).toBe(true), {
    timeout: 10000,
  });

  // Positive control: the age is actually climbing before the step.
  await waitFor(
    () => expect(result.current.recorderStaleMs ?? 0).toBeGreaterThan(1000),
    {
      timeout: 6000,
    },
  );
  const beforeStep = result.current.recorderStaleMs!;

  stepSystemClock(-60_000);

  // Wait for an age computed AFTER the step, then check it did not go backwards.
  await waitFor(() => expect(result.current.recorderStaleMs).not.toBe(beforeStep), {
    timeout: 6000,
  });
  expect(result.current.recorderStaleMs).toBeGreaterThanOrEqual(beforeStep);
}, 30000);
