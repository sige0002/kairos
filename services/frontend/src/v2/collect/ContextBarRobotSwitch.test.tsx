// Collect's ContextBar pickers vs a live recording — Robot, Project and Task.
//
// Settings > Robots takes a careful path for this: it confirms, stops the
// recorder, and aborts the switch if the stop fails. Collect looked equally
// safe because the Robot cell is `disabled` while recording — but that
// `disabled` is on the button that OPENS the picker, the items inside carried
// no guard, and nothing dismissed the popover. So a picker opened BEFORE Start
// stayed live and clickable after it, switching the robot mid-recording with no
// confirmation and no stop.
//
// The sequence below is the reachable one: pure local UI, one browser, no
// second terminal.

import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { useUiStore } from '../../store/uiStore';
import { CollectScreen } from './CollectScreen';
import { __resetBatchStore, __setStopFloorMs, __resetStopFloorMs } from './useBatchMachine';
import { __resetCameraStore } from './cameraStore';
import { __resetPlansStore } from '../plans';

const CONFIG = {
  endpoints: { api: '/api/v1', events: '/api/v1/events', webrtc: 'http://localhost:8002' },
  tabs: [],
  defaults: { default_topics: [] },
  schemas: {},
};

const OPTIONS = {
  active_robot: 'airoa_hsr',
  robots: [
    { id: 'airoa_hsr', local: false },
    { id: 'myrobot', local: true },
  ],
  aspects: {},
};

const CAP_1 = '0192f0aa-2222-7000-8000-000000000002';

let recording = false;

function mockFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = (init as RequestInit)?.method ?? 'GET';
    if (url.includes('/config/options')) return Promise.resolve(jsonResponse(OPTIONS));
    if (url.includes('/config/select')) {
      const body = JSON.parse(String((init as RequestInit).body));
      return Promise.resolve(jsonResponse({ ...OPTIONS, active_robot: body.id }));
    }
    if (url.includes('/record/start')) {
      recording = true;
      return Promise.resolve(
        jsonResponse({
          capture_id: CAP_1,
          run_id: 'run_20260805_120000',
          state: 'recording',
          review_status: 'pending',
          review_revision: 0,
        }),
      );
    }
    if (url.includes('/record/stop')) {
      recording = false;
      return Promise.resolve(
        jsonResponse({
          capture_id: CAP_1,
          run_id: 'run_20260805_120000',
          state: 'completed',
          review_status: 'pending',
          review_revision: 0,
          integrity: 'ok',
          quick_check: 'ok',
        }),
      );
    }
    if (url.match(/\/captures\/[^/]+\/review/)) {
      return Promise.resolve(
        jsonResponse({
          capture_id: CAP_1,
          run_id: 'run_20260805_120000',
          state: 'completed',
          review_status: 'adopted',
          review_revision: 1,
        }),
      );
    }
    if (url.match(/\/captures\/[^/]+$/)) {
      return Promise.resolve(
        jsonResponse({
          capture_id: CAP_1,
          run_id: 'run_20260805_120000',
          state: 'completed',
          review_status: 'pending',
          review_revision: 0,
          integrity: 'ok',
          quick_check: 'ok',
        }),
      );
    }
    if (url.includes('/record/status')) {
      return Promise.resolve(
        jsonResponse({
          run_id: recording ? 'run_20260805_120000' : null,
          capture_id: recording ? CAP_1 : null,
          state: recording ? 'recording' : 'created',
          live_capture_ids: recording ? [CAP_1] : [],
        }),
      );
    }
    if (url.includes('/config')) return Promise.resolve(jsonResponse(CONFIG));
    if (method === 'POST' || method === 'PATCH') return Promise.resolve(jsonResponse({}));
    return Promise.resolve(jsonResponse({}));
  });
}

/** The `/config/select` bodies fetch has actually seen. */
function selectPosts() {
  const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
  return calls
    .filter((c) => String(c[0]).includes('/config/select'))
    .map((c) => JSON.parse(String((c[1] as RequestInit).body)));
}

/** Let a mutation's fetch actually leave: `mutate` dispatches in a microtask, so
 *  asserting synchronously reports "nothing fired" even when it did. */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const robotCell = () => screen.getByRole('button', { name: /Robot/ });

beforeEach(() => {
  setApiBase('/api/v1');
  recording = false;
  __resetBatchStore();
  __resetCameraStore();
  __resetPlansStore();
  useUiStore.setState({ recordOperator: 'tester' });
  __setStopFloorMs(0);
  mockFetch();
});
afterEach(() => {
  __resetStopFloorMs();
  vi.restoreAllMocks();
});

/** One saved episode, so recordedCount >= 1 and a later context change routes
 *  through rolloverSet rather than a plain SET_PROJECT. */
async function recordAndSaveOneEpisode() {
  await waitFor(() => expect(screen.getByTestId('phase-title')).toHaveTextContent('READY'));
  fireEvent.click(screen.getByRole('button', { name: /Start recording/ }));
  await waitFor(() => expect(screen.getByTestId('phase-title')).toHaveTextContent('RECORDING'));
  fireEvent.click(screen.getByRole('button', { name: /Stop recording/ }));
  await waitFor(() => expect(screen.getByTestId('phase-title')).toHaveTextContent(/result/i), {
    timeout: 5000,
  });
  fireEvent.click(screen.getByTestId('save-episode'));
  await waitFor(() => expect(screen.getByTestId('stat-recorded')).toHaveTextContent('1'));
}

test('the robot picker works while idle (control for the guard below)', async () => {
  renderWithClient(<CollectScreen />);
  await waitFor(() => expect(robotCell()).toBeEnabled());

  fireEvent.click(robotCell());
  fireEvent.click(await screen.findByRole('button', { name: /myrobot/ }));
  await flush();

  // Without this passing, the guard test below would prove nothing.
  expect(selectPosts()).toEqual([{ category: 'robot', id: 'myrobot' }]);
});

test('a picker opened BEFORE Start cannot switch the robot once recording', async () => {
  renderWithClient(<CollectScreen />);
  await waitFor(() => expect(robotCell()).toBeEnabled());

  // 1. open the picker while idle
  fireEvent.click(robotCell());
  expect(await screen.findByRole('button', { name: /myrobot/ })).toBeInTheDocument();

  // 2. start recording — a different element, so nothing dismisses the popover
  fireEvent.click(screen.getByRole('button', { name: /Start recording/ }));

  // 3. wait until the guard is genuinely active
  await waitFor(() => expect(robotCell()).toBeDisabled());

  // 4. the popover must be gone with it — an open list of robots over a running
  //    recording invites exactly the click that must not happen.
  expect(screen.queryByRole('button', { name: /myrobot/ })).not.toBeInTheDocument();

  // Belt and braces, and worth naming so the next reader does not mistake it
  // for the load-bearing assertion: this test never clicks while recording, so
  // the line above (the item is gone) is what actually proves the guard. If the
  // dismissal regressed, THIS would still pass.
  await flush();
  expect(selectPosts()).toEqual([]);
});

// NOT COVERED HERE, deliberately — FOUR guards, not one. `PickItem`'s own
// `if (disabled) return` for the robot cell, and the `if (!ctxEditable) return`
// at the top of `pickProject`, `pickTask` and `pickCustomTask`. Once the
// dismissal lands there is no rendered item left to click at any of the four, so
// those branches are unreachable through the UI and no honest test can drive
// them — each can be deleted on its own and this file stays green. A first
// version of this file appeared to cover the robot one and did not: the click
// was landing on a detached node. They are kept as defence in depth so that a
// regression in the dismissal does not immediately become a mid-recording
// switch or re-label again, and they are verified by reading, not by this file.
//
// What IS covered is the dismissal itself (removing it reds the three tests
// above) and the dependency that makes the guards read the CURRENT ctxEditable
// rather than a memoised one (the test below).

// The Robot cell was fixed first; Project and Task are the same structure with
// the same `ctxEditable` gate, and had the same hole. They are worse than a
// mislabel: with one episode already recorded, picking here routes through
// rolloverSet, whose server-side "close the old set" PATCH is skipped while
// recording (it only fires for the at-rest phases) while the local
// ROLLOVER_SET runs anyway — so the set rolls over under a live recording and
// the server is never told the old set ended. Measured before the fix: the
// picker stayed open, the Project cell went "Tabletop Manipulation" ->
// "Bin Picking" with the SAME recording still in flight, and the recorded
// count reset from 1 to 0.

test('a Project picker opened BEFORE Start cannot re-label a live recording', async () => {
  renderWithClient(<CollectScreen />);
  await recordAndSaveOneEpisode();

  fireEvent.click(screen.getByRole('button', { name: /Project/ }));
  expect(await screen.findByRole('button', { name: /Bin Picking/ })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /Start recording/ }));
  await waitFor(() => expect(screen.getByTestId('phase-title')).toHaveTextContent('RECORDING'));

  // The list is gone with the guard, so there is nothing to click …
  expect(screen.queryByRole('button', { name: /Bin Picking/ })).not.toBeInTheDocument();
  // … and the context the in-flight recording belongs to is untouched.
  expect(screen.getByRole('button', { name: /Project/ })).toHaveTextContent(
    'Tabletop Manipulation',
  );
  expect(screen.getByTestId('stat-recorded')).toHaveTextContent('1');
});

test('a Task picker opened BEFORE Start cannot re-label a live recording', async () => {
  renderWithClient(<CollectScreen />);
  await recordAndSaveOneEpisode();

  fireEvent.click(screen.getByRole('button', { name: /^Task/ }));
  expect(await screen.findByRole('button', { name: /Stacking/ })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /Start recording/ }));
  await waitFor(() => expect(screen.getByTestId('phase-title')).toHaveTextContent('RECORDING'));

  expect(screen.queryByRole('button', { name: /Stacking/ })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^Task/ })).toHaveTextContent('Pick and Place');
  expect(screen.getByTestId('stat-recorded')).toHaveTextContent('1');
});

/** The stale-closure window, and the one bug in this area that has already
 *  happened once. `pickProject`/`pickTask`/`pickCustomTask` guard on
 *  `ctxEditable`; if that value is missing from their `useCallback` deps the
 *  guard reads whatever was captured when the deps last changed — and the deps
 *  DO change mid-take, because the batch is created while `ctxEditable` is
 *  false. The callback is then frozen with `false` and silently refuses a
 *  perfectly legitimate context change once back at ready: a guard failing in
 *  the safe-looking direction, which is worse than no guard at all.
 *
 *  ONE TEST PER HANDLER, not one for both: acting on either handler first runs
 *  a toast that refreshes the other's deps and unfreezes it, so a combined test
 *  masks whichever it exercises second. Measured, not assumed — the combined
 *  version stayed green with pickProject's dep deleted. */
async function saveOneEpisodeThenReturnToReady() {
  await recordAndSaveOneEpisode();
  await waitFor(() => expect(screen.getByTestId('phase-title')).toHaveTextContent('READY'));
}

test('a PROJECT change is still allowed on the take after one is saved', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  renderWithClient(<CollectScreen />);
  await saveOneEpisodeThenReturnToReady();

  fireEvent.click(screen.getByRole('button', { name: /Project/ }));
  fireEvent.click(await screen.findByRole('button', { name: /Bin Picking/ }));

  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Project/ })).toHaveTextContent('Bin Picking'),
  );
  // Rolled over: the new set starts empty, and the earlier episode stays with
  // the set it was recorded under.
  expect(screen.getByTestId('stat-recorded')).toHaveTextContent('0');
});

test('a TASK change is still allowed on the take after one is saved', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  renderWithClient(<CollectScreen />);
  await saveOneEpisodeThenReturnToReady();

  fireEvent.click(screen.getByRole('button', { name: /^Task/ }));
  fireEvent.click(await screen.findByRole('button', { name: /Stacking/ }));

  await waitFor(() =>
    expect(screen.getByRole('button', { name: /^Task/ })).toHaveTextContent('Stacking'),
  );
  expect(screen.getByTestId('stat-recorded')).toHaveTextContent('0');
});

test('`r` does not start a take while the Robot picker is open', async () => {
  // The machine's `anyOverlayOpen` guard enumerates the overlays the MACHINE
  // owns. The Robot picker's open state lived in ContextBar as component state,
  // so the guard could not see it and `r` fell straight through to Start —
  // while the picker was on screen, and the dismissal effect then wiped the
  // list at the same instant, giving the operator no visible connection
  // between the key they pressed and the recording that began.
  renderWithClient(<CollectScreen />);
  await waitFor(() => expect(screen.getByTestId('phase-title')).toHaveTextContent('READY'));

  fireEvent.click(robotCell());
  expect(await screen.findByRole('button', { name: /myrobot/ })).toBeInTheDocument();

  fireEvent.keyDown(window, { key: 'r' });
  await flush();

  const starts = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter((c) =>
    String(c[0]).includes('/record/start'),
  );
  expect(starts).toHaveLength(0);
  expect(screen.getByTestId('phase-title')).toHaveTextContent('READY');
});
