// #8, the interaction half: ARMING's Cancel must not answer to the press that
// put it on screen.
//
// The Collect card swaps one full-width control for another in the same place
// on every phase change, so the second press of a real double-click (~86 ms
// after the first, measured) lands on whatever replaced the button it hit.
// Start -> Cancel is the worst of those pairs: it backs out of a take the
// recorder has already begun. Cancel therefore ignores its first
// ARMING_CANCEL_GUARD_MS on screen — and, past that window, works exactly as
// before, because an operator who reads ARMING… and decides to back out must
// still be able to.

import { act, fireEvent, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { useUiStore } from '../../store/uiStore';
import { CollectScreen } from './CollectScreen';
import { __resetCameraStore } from './cameraStore';
import { __resetPlansStore } from '../plans';
import { __resetBatchStore } from './useBatchMachine';
import { useActivationGuard } from './hooks/useActivationGuard';
import { ARMING_CANCEL_GUARD_MS } from './machine/types';

const CONFIG = {
  endpoints: { api: '/api/v1', events: '/api/v1/events', webrtc: 'http://localhost:8002' },
  tabs: [],
  defaults: { default_topics: [] },
  schemas: {},
};

beforeEach(() => {
  setApiBase('/api/v1');
  __resetPlansStore();
  __resetBatchStore();
  __resetCameraStore();
  useUiStore.setState({
    activeTab: '',
    sseStatus: 'closed',
    monitorBridge: null,
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

// ---------------------------------------------------------------------------
// The guard itself.
// ---------------------------------------------------------------------------

test('the activation guard opens only after its delay, and re-arms per activation', () => {
  vi.useFakeTimers();
  const { result, rerender } = renderHook(
    ({ active }: { active: boolean }) => useActivationGuard(active, 350),
    { initialProps: { active: false } },
  );
  expect(result.current).toBe(false);

  rerender({ active: true });
  expect(result.current).toBe(false);
  // The double-click tail, and a wide margin past it.
  act(() => vi.advanceTimersByTime(86));
  expect(result.current).toBe(false);
  act(() => vi.advanceTimersByTime(349 - 86));
  expect(result.current).toBe(false);
  act(() => vi.advanceTimersByTime(1));
  expect(result.current).toBe(true);

  // Leaving and re-entering the phase serves a fresh guard, not the spent one.
  rerender({ active: false });
  expect(result.current).toBe(false);
  rerender({ active: true });
  expect(result.current).toBe(false);
  act(() => vi.advanceTimersByTime(350));
  expect(result.current).toBe(true);
});

// ---------------------------------------------------------------------------
// The guard where it matters: the real screen, mid-arming.
// ---------------------------------------------------------------------------

/** CollectScreen with /record/start held open, so ARMING stays on screen for
 *  as long as the test needs it. */
function armingFetch() {
  let releaseStart!: () => void;
  const startHeld = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/config')) return Promise.resolve(jsonResponse(CONFIG));
    if (url.includes('/record/start'))
      return startHeld.then(() =>
        jsonResponse({
          capture_id: 'cap_guard',
          run_id: 'run_cap_guard',
          state: 'recording',
          review_status: 'pending',
          review_revision: 0,
        }),
      );
    return Promise.resolve(jsonResponse({}));
  });
  return { releaseStart, startHeld };
}

const phaseTitle = () => screen.getByTestId('phase-title');

test('the tail of a double-click on Start cannot cancel the arming take', async () => {
  const held = armingFetch();
  renderWithClient(<CollectScreen />);
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));

  fireEvent.click(screen.getByRole('button', { name: /Start recording/ }));
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('ARMING…'));

  // The second press, milliseconds later, on the control that took Start's
  // place. It is not merely ignored — the button says it is not ready.
  const cancel = screen.getByTestId('arming-cancel');
  expect(cancel).toBeDisabled();
  fireEvent.click(cancel);
  expect(phaseTitle()).toHaveTextContent('ARMING…');

  // Focus is not nowhere while the button cannot hold it. A disabled button
  // refuses focus(), which used to drop it on <body> — where the next Space
  // press scrolls the page instead of reaching the flow (D-4).
  expect(document.activeElement).not.toBe(document.body);
  expect(phaseTitle()).toHaveFocus();

  await act(async () => {
    held.releaseStart();
    await held.startHeld;
  });
});

test('a deliberate cancel, after the guard window, still backs out', async () => {
  const held = armingFetch();
  renderWithClient(<CollectScreen />);
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));

  fireEvent.click(screen.getByRole('button', { name: /Start recording/ }));
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('ARMING…'));

  // The guard is shut first — asserted here as well as in the double-click test
  // so that removing the guard fails THIS test too, rather than leaving it
  // green on focus behaviour alone.
  const cancel = screen.getByTestId('arming-cancel');
  expect(cancel).toBeDisabled();
  fireEvent.click(cancel);
  expect(phaseTitle()).toHaveTextContent('ARMING…');

  // Real timers: this is the shipped delay, not a seam, so the test proves the
  // window an operator actually waits out.
  await waitFor(() => expect(cancel).toBeEnabled(), {
    timeout: ARMING_CANCEL_GUARD_MS + 2000,
  });
  // The guard hands focus on once it opens — a disabled button cannot take it,
  // so without this the phase would be keyboard-dead (D-4).
  expect(cancel).toHaveFocus();

  fireEvent.click(cancel);
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));

  await act(async () => {
    held.releaseStart();
    await held.startHeld;
  });
});
