// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// #36/#37 acceptance, driven entirely by the documented key chords
// (Ctrl+Alt+1/2/3) against the real CollectScreen with a mocked transport:
// the full success and failure workflows, the state table's unsafe states,
// the input guards (typing, modal, saving, takeover, repeat/latch), the
// per-Task failure mapping, and the HUD that must always tell the truth.
//
// No physical pedal is involved — the chords on an ordinary keyboard ARE the
// acceptance path (a programmable pedal maps its switches onto exactly these
// events).

import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { useUiStore } from '../../store/uiStore';
import { CollectScreen } from './CollectScreen';
import {
  __resetBatchStore,
  __rehydrateBatchStore,
  __setStopFloorMs,
  __resetStopFloorMs,
} from './useBatchMachine';
import { __resetCameraStore } from './cameraStore';
import { setPlans, __resetPlansStore } from '../plans';

const CONFIG = {
  endpoints: {
    api: '/api/v1',
    events: '/api/v1/events',
    webrtc: 'http://localhost:8002',
  },
  tabs: [],
  defaults: { default_topics: [] },
  schemas: {},
};

const OTHER_CAP = '0192f0aa-3333-7000-8000-000000000099';
let recording = false;
// A real recorder mints a NEW capture_id per start; reusing one across takes
// would let the previous take's terminal status falsely "interrupt" the next
// one (the healthy-end detector keys on the capture id). The mock mirrors that.
let captureSeq = 0;
let currentCapture = '0192f0aa-3333-7000-8000-000000000000';
let reviewBodies: unknown[] = [];
let deleteBodies: unknown[] = [];
let startBodies: unknown[] = [];
let startCalls = 0;
let stopDelayMs = 0;
// Regression seam: make the /delete endpoint refuse, to prove a failed
// discard leaves neither a second recording nor an armed auto-start behind.
let deleteShouldFail = false;
let holdDelete = false;
let resolveHeldDelete: (() => void) | null = null;
let holdCaptureInvalidation = false;
let resolveHeldCaptureInvalidation: (() => void) | null = null;

/** The catalog the tests run against: TWO tasks with different shortcuts, so
 *  a task switch observably changes the three effective reasons (#35/#36). */
function seedPlans() {
  setPlans([
    {
      project_id: 'project-tabletop',
      name: 'Tabletop',
      tasks: [
        {
          task_id: 'task-pick',
          name: 'Pick and Place',
          conditions: [],
          failure_shortcuts: {
            left: 'Grasp missed',
            center: 'Object dropped',
            right: 'Wrong placement',
          },
        },
        {
          task_id: 'task-stack',
          name: 'Stacking',
          conditions: [],
          failure_shortcuts: {
            left: 'Robot fault',
            center: 'Other',
            right: null,
          },
        },
      ],
    },
  ]);
}

function mockFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = (init as RequestInit)?.method ?? 'GET';
    if (url.includes('/config/options')) {
      return Promise.resolve(
        jsonResponse({ active_robot: 'r', robots: [], aspects: {} }),
      );
    }
    if (url.includes('/record/start')) {
      startCalls += 1;
      startBodies.push((init as RequestInit)?.body ?? null);
      captureSeq += 1;
      currentCapture = `0192f0aa-3333-7000-8000-00000000000${captureSeq}`;
      recording = true;
      return Promise.resolve(jsonResponse(completed('recording')));
    }
    if (url.includes('/record/stop')) {
      if (stopDelayMs > 0) {
        return new Promise((resolve) =>
          setTimeout(() => {
            recording = false;
            resolve(jsonResponse(completed('completed')));
          }, stopDelayMs),
        );
      }
      recording = false;
      return Promise.resolve(jsonResponse(completed('completed')));
    }
    if (url.match(/\/captures\/[^/]+\/review/)) {
      if (init) reviewBodies.push((init as RequestInit).body);
      return Promise.resolve(
        jsonResponse({ ...completed('completed'), review_revision: 1 }),
      );
    }
    if (url.match(/\/captures\/[^/]+\/delete$/)) {
      // A discard is NOT a review: track its own body and answer with the
      // capture's discarded tombstone, as the API does.
      deleteBodies.push((init as RequestInit)?.body ?? null);
      if (deleteShouldFail) {
        return Promise.resolve(
          jsonResponse(
            { error: { code: 'internal', message: 'delete exploded' } },
            500,
          ),
        );
      }
      if (holdDelete) {
        return new Promise((resolve) => {
          resolveHeldDelete = () => resolve(jsonResponse(completed('discarded')));
        });
      }
      return Promise.resolve(jsonResponse(completed('discarded')));
    }
    if (holdCaptureInvalidation && method === 'GET' && /\/captures(?:\?|$)/.test(url)) {
      return new Promise((resolve) => {
        resolveHeldCaptureInvalidation = () =>
          resolve(jsonResponse({ items: [], next_cursor: null }));
      });
    }
    if (url.match(/\/captures\/[^/]+$/)) {
      return Promise.resolve(jsonResponse(completed('completed')));
    }
    if (url.includes('/record/status')) {
      // A real recorder reports the stopped capture with its integrity
      // shortly after the stop — mirror that so QUICK CHECK settles on the
      // real signal instead of the 3 s fallback (the tests assert behavior,
      // not the backstop).
      return Promise.resolve(
        jsonResponse({
          run_id: 'run_x',
          capture_id: currentCapture,
          state: recording ? 'recording' : 'completed',
          live_capture_ids: recording ? [currentCapture] : [],
          integrity: recording ? null : 'ok',
        }),
      );
    }
    if (url.includes('/config')) return Promise.resolve(jsonResponse(CONFIG));
    if (method === 'POST' || method === 'PATCH')
      return Promise.resolve(jsonResponse({}));
    return Promise.resolve(jsonResponse({}));
  });
}

function completed(state: string) {
  return {
    capture_id: currentCapture,
    run_id: 'run_20260805_130000',
    state,
    review_status: 'pending',
    review_revision: 0,
    integrity: 'ok',
    quick_check: 'ok',
  };
}

/** The documented chords (#36): Ctrl+Alt+1/2/3 = LEFT / CENTER / RIGHT. */
function press(slot: 'left' | 'center' | 'right', extra: Record<string, unknown> = {}) {
  const code = { left: 'Digit1', center: 'Digit2', right: 'Digit3' }[slot];
  fireEvent.keyDown(window, {
    key: { left: '1', center: '2', right: '3' }[slot],
    code,
    ctrlKey: true,
    altKey: true,
    ...extra,
  });
}
function release(slot: 'left' | 'center' | 'right') {
  const code = { left: 'Digit1', center: 'Digit2', right: 'Digit3' }[slot];
  fireEvent.keyUp(window, {
    key: { left: '1', center: '2', right: '3' }[slot],
    code,
    ctrlKey: true,
    altKey: true,
  });
}

const phaseTitle = () => screen.getByTestId('phase-title');
const recorded = () => screen.getByTestId('stat-recorded');
const hud = (slot: 'left' | 'center' | 'right') =>
  screen.getByTestId(`ext-action-${slot}-meaning`);
function toastSays(fragment: string) {
  return screen
    .getAllByRole('status')
    .some((region) => (region.textContent ?? '').includes(fragment));
}

function reviewBody() {
  return JSON.parse(String(reviewBodies.at(-1))) as Record<string, unknown>;
}

function startLabelFields(body: unknown) {
  const request = JSON.parse(String(body)) as Record<string, unknown>;
  const context = request.collection_context as Record<string, unknown>;
  return {
    project: context.project,
    task: request.task,
    condition: context.condition,
    operator: request.operator,
    topics: request.topics,
  };
}

beforeEach(() => {
  setApiBase('/api/v1');
  recording = false;
  captureSeq = 0;
  currentCapture = '0192f0aa-3333-7000-8000-000000000000';
  reviewBodies = [];
  deleteBodies = [];
  startBodies = [];
  startCalls = 0;
  stopDelayMs = 0;
  deleteShouldFail = false;
  holdDelete = false;
  resolveHeldDelete = null;
  holdCaptureInvalidation = false;
  resolveHeldCaptureInvalidation = null;
  __resetBatchStore();
  __resetCameraStore();
  __resetPlansStore();
  seedPlans();
  useUiStore.setState({ recordOperator: 'tester' });
  __setStopFloorMs(0);
  mockFetch();
});
afterEach(() => {
  __resetStopFloorMs();
  vi.restoreAllMocks();
});

test('the common SUCCESS workflow runs on the three chords alone', async () => {
  renderWithClient(<CollectScreen />);
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));

  // HUD agrees with what a press will do: CENTER = Start, sides disabled.
  expect(hud('center').textContent).toBe('Start');
  expect(hud('left').textContent).toBe('—');
  expect(hud('right').textContent).toBe('—');

  press('center');
  release('center');
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('RECORDING'));

  // RECORDING HUD: CENTER = Stop.
  expect(hud('center').textContent).toBe('Stop');

  press('center');
  release('center');
  await waitFor(() => expect(phaseTitle()).toHaveTextContent(/result/i), {
    timeout: 5000,
  });

  // RESULT HUD: LEFT = Failure, CENTER = Retake, RIGHT = Success + Save.
  expect(hud('left').textContent).toBe('Failure');
  expect(hud('center').textContent).toBe('Retake');
  expect(hud('right').textContent).toBe('Success + Save');

  press('right');
  release('right');
  await waitFor(() => expect(recorded()).toHaveTextContent('1'));
  expect(reviewBody().task_result).toBe('success');
});

test('the common FAILURE workflow: LEFT selects Failure, a slot saves its reason', async () => {
  renderWithClient(<CollectScreen />);
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));
  press('center');
  release('center');
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('RECORDING'));
  press('center');
  release('center');
  await waitFor(() => expect(phaseTitle()).toHaveTextContent(/result/i), {
    timeout: 5000,
  });

  // LEFT selects Failure — visible, and nothing is saved yet.
  press('left');
  release('left');
  await waitFor(() => expect(hud('left').textContent).toBe('Grasp missed'));
  expect(reviewBodies).toHaveLength(0);
  expect(phaseTitle()).toHaveTextContent(/result/i);

  // The HUD now shows the current TASK's three reasons, with the task named.
  expect(hud('center').textContent).toBe('Object dropped');
  expect(hud('right').textContent).toBe('Wrong placement');
  expect(screen.getByTestId('ext-action-task-name').textContent).toBe('Pick and Place');

  // CENTER saves with the CENTER reason — the exact string, no fallback.
  press('center');
  release('center');
  await waitFor(() => expect(recorded()).toHaveTextContent('1'));
  const body = reviewBody();
  expect(body.task_result).toBe('failure');
  expect(body.failure_reason).toBe('Object dropped');
});

test('CENTER on RESULT before Failure is Retake: discard without saving, then record again', async () => {
  renderWithClient(<CollectScreen />);
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));
  press('center');
  release('center');
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('RECORDING'));
  press('center');
  release('center');
  await waitFor(() => expect(phaseTitle()).toHaveTextContent(/result/i), {
    timeout: 5000,
  });

  // The HUD names the slot before it is used.
  expect(hud('center').textContent).toBe('Retake');

  press('center');
  release('center');
  // The press is a DISCARD, not a review: the delete request carries the
  // retake's ledger reason, and nothing reaches the review endpoint.
  await waitFor(() => expect(deleteBodies).toHaveLength(1), { timeout: 5000 });
  expect(reviewBodies).toHaveLength(0);
  const body = JSON.parse(String(deleteBodies[0])) as Record<string, unknown>;
  expect(body.kind).toBe('discard');
  expect(body.reason).toBe('Superseded by retake (Collect)');
  // …and the second take is already rolling under the same labels.
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('RECORDING'), {
    timeout: 5000,
  });
  expect(startCalls).toBe(2);
  expect(startBodies).toHaveLength(2);
  expect(startLabelFields(startBodies[1])).toEqual(startLabelFields(startBodies[0]));
});

test('a pending Retake disables the HUD and absorbs a release/repress until its discard resolves', async () => {
  renderWithClient(<CollectScreen />);
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));
  press('center');
  release('center');
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('RECORDING'));
  press('center');
  release('center');
  await waitFor(() => expect(phaseTitle()).toHaveTextContent(/result/i), {
    timeout: 5000,
  });

  holdDelete = true;
  press('center');
  release('center');
  // Re-press before React has to publish `busy`: the synchronous discard
  // guard, not a later disabled render, owns this narrow race.
  press('center');
  release('center');

  await waitFor(() => expect(deleteBodies).toHaveLength(1), { timeout: 5000 });
  await waitFor(() => expect(hud('center').textContent).toBe('—'));
  expect(resolveHeldDelete).not.toBeNull();

  resolveHeldDelete?.();
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('RECORDING'), {
    timeout: 5000,
  });
  expect(startCalls).toBe(2);
  expect(deleteBodies).toHaveLength(1);
});

test('Retake keeps external Start disabled until its capture invalidation settles', async () => {
  renderWithClient(<CollectScreen />);
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));
  press('center');
  release('center');
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('RECORDING'));
  press('center');
  release('center');
  await waitFor(() => expect(phaseTitle()).toHaveTextContent(/result/i), {
    timeout: 5000,
  });

  // onDeleted moves the machine to READY before the shared deletion flow
  // awaits this refetch. Hold it open to cover that otherwise tiny window.
  holdCaptureInvalidation = true;
  press('center');
  release('center');
  await waitFor(() => expect(resolveHeldCaptureInvalidation).not.toBeNull());
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));
  await waitFor(() => expect(hud('center').textContent).toBe('—'));

  // A pedal release/repress cannot start a manual take while Retake is still
  // completing its discard; only the queued restart may do that.
  press('center');
  release('center');
  expect(startCalls).toBe(1);

  resolveHeldCaptureInvalidation?.();
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('RECORDING'), {
    timeout: 5000,
  });
  expect(startCalls).toBe(2);
});

test('a rejected Retake cache invalidation reports the error and does not restart', async () => {
  const { client } = renderWithClient(<CollectScreen />);
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));
  press('center');
  release('center');
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('RECORDING'));
  press('center');
  release('center');
  await waitFor(() => expect(phaseTitle()).toHaveTextContent(/result/i), {
    timeout: 5000,
  });

  vi.spyOn(client, 'invalidateQueries').mockRejectedValueOnce(
    new Error('capture refresh unavailable'),
  );
  press('center');
  release('center');

  await waitFor(() => expect(toastSays('capture refresh unavailable')).toBe(true));
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));
  // The rejected invalidation resolves discardNow(false), so Retake never
  // queues its own restart and does not leave an unhandled promise behind.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
  expect(startCalls).toBe(1);
});

test('a FAILED retake discard starts nothing and leaves no queued auto-start', async () => {
  renderWithClient(<CollectScreen />);
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));
  press('center');
  release('center');
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('RECORDING'));
  press('center');
  release('center');
  await waitFor(() => expect(phaseTitle()).toHaveTextContent(/result/i), {
    timeout: 5000,
  });

  deleteShouldFail = true;
  press('center');
  release('center');
  await waitFor(() => expect(deleteBodies).toHaveLength(1), { timeout: 5000 });
  // The refusal is told in the toast, and the operator is still standing at
  // the take that survived it.
  await waitFor(() => expect(toastSays('delete exploded')).toBe(true));
  expect(phaseTitle()).toHaveTextContent(/result/i);
  expect(startCalls).toBe(1);

  // Save the take — with the batch target of 30 the machine returns to READY
  // for the next episode. A retake queued by the FAILED discard above would
  // arm itself exactly here and start a recording on its own; it must not.
  press('right');
  release('right');
  await waitFor(() => expect(recorded()).toHaveTextContent('1'));
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));
  // Let any wrongly armed auto-start have its chance to misfire, then prove
  // there was none.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
  expect(startCalls).toBe(1);
  expect(phaseTitle()).toHaveTextContent('READY');
});

test('LEFT/RIGHT do nothing while recording (no accidental reason stamp)', async () => {
  renderWithClient(<CollectScreen />);
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));
  press('center');
  release('center');
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('RECORDING'));

  press('left');
  release('left');
  press('right');
  release('right');
  expect(phaseTitle()).toHaveTextContent('RECORDING');
  expect(reviewBodies).toHaveLength(0);
});

test('RIGHT on RESULT saves Success even when Failure was touched and backed out', async () => {
  renderWithClient(<CollectScreen />);
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));
  press('center');
  release('center');
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('RECORDING'));
  press('center');
  release('center');
  await waitFor(() => expect(phaseTitle()).toHaveTextContent(/result/i), {
    timeout: 5000,
  });

  press('left');
  release('left');
  await waitFor(() => expect(hud('left').textContent).toBe('Grasp missed'));
  // Back out via the mouse (the fallback stays fully functional)…
  fireEvent.click(screen.getByRole('button', { name: /Success/ }));
  // …and RIGHT is Success + Save again.
  expect(hud('right').textContent).toBe('Success + Save');
  press('right');
  release('right');
  await waitFor(() => expect(recorded()).toHaveTextContent('1'));
  expect(reviewBody().task_result).toBe('success');
});

test('unassigned slot: visible feedback, and NO save, ever', async () => {
  // Switch to the task whose RIGHT slot is unassigned BEFORE recording.
  renderWithClient(<CollectScreen />);
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));
  fireEvent.click(screen.getByTitle('Change task (from plan)'));
  fireEvent.click(await screen.findByRole('button', { name: 'Stacking' }));

  press('center');
  release('center');
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('RECORDING'));
  press('center');
  release('center');
  await waitFor(() => expect(phaseTitle()).toHaveTextContent(/result/i), {
    timeout: 5000,
  });

  press('left');
  release('left');
  // The HUD shows the OTHER task's reasons immediately (task switch changed
  // the effective mapping)…
  await waitFor(() => expect(hud('left').textContent).toBe('Robot fault'));
  expect(hud('right').textContent).toBe('Unassigned');
  expect(screen.getByTestId('ext-action-task-name').textContent).toBe('Stacking');

  // …and pressing the unassigned slot explains itself without saving.
  press('right');
  release('right');
  await waitFor(() => expect(toastSays('RIGHT is unassigned for Stacking')).toBe(true));
  expect(reviewBodies).toHaveLength(0);
  expect(phaseTitle()).toHaveTextContent(/result/i);
});

test("a same-label custom task never falls back to another task's failure shortcuts", async () => {
  // This exact label exists in the catalog. Its custom selection must still
  // carry taskId: null, rather than resolving the catalog task by name.
  vi.spyOn(window, 'prompt').mockReturnValue('Pick and Place');
  renderWithClient(<CollectScreen />);
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));

  fireEvent.click(screen.getByTitle('Change task (from plan)'));
  fireEvent.click(screen.getByRole('button', { name: /Custom/ }));
  await waitFor(() => expect(screen.getByText('Pick and Place')).toBeInTheDocument());

  press('center');
  release('center');
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('RECORDING'));
  press('center');
  release('center');
  await waitFor(() => expect(phaseTitle()).toHaveTextContent(/result/i), {
    timeout: 5000,
  });

  // Failure may still be selected, but a custom/stale task owns no catalog
  // shortcuts. Never borrow the first task's "Grasp missed" mapping.
  press('left');
  release('left');
  await waitFor(() => expect(hud('left').textContent).toBe('Unassigned'));
  expect(hud('center').textContent).toBe('Unassigned');
  expect(hud('right').textContent).toBe('Unassigned');
  expect(screen.queryByTestId('ext-action-task-name')).not.toBeInTheDocument();

  press('center');
  release('center');
  await waitFor(() => expect(toastSays('CENTER is unassigned')).toBe(true));
  expect(reviewBodies).toHaveLength(0);
  expect(phaseTitle()).toHaveTextContent(/result/i);
});

test('same-name catalog tasks resolve the selected task ID, not the first label match', async () => {
  setPlans([
    {
      project_id: 'project-collision',
      name: 'Collision',
      tasks: [
        {
          task_id: 'task-first',
          name: 'Repeat',
          conditions: [],
          failure_shortcuts: { left: 'First reason', center: null, right: null },
        },
        {
          task_id: 'task-second',
          name: 'Repeat',
          conditions: [],
          failure_shortcuts: { left: 'Second reason', center: null, right: null },
        },
      ],
    },
  ]);
  __resetBatchStore();
  renderWithClient(<CollectScreen />);
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));

  fireEvent.click(screen.getByTitle('Change task (from plan)'));
  fireEvent.click(screen.getAllByRole('button', { name: 'Repeat' })[1]!);

  press('center');
  release('center');
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('RECORDING'));
  press('center');
  release('center');
  await waitFor(() => expect(phaseTitle()).toHaveTextContent(/result/i), {
    timeout: 5000,
  });
  press('left');
  release('left');

  await waitFor(() => expect(hud('left').textContent).toBe('Second reason'));
});

test('a deleted and same-name replacement task cannot inherit the old selection', async () => {
  renderWithClient(<CollectScreen />);
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));

  // Keep the machine's original IDs, then replace the catalog with a new item
  // carrying the same visible names. A name lookup would incorrectly use this.
  await act(async () => {
    setPlans([
      {
        project_id: 'project-replacement',
        name: 'Tabletop',
        tasks: [
          {
            task_id: 'task-replacement',
            name: 'Pick and Place',
            conditions: [],
            failure_shortcuts: {
              left: 'Replacement reason',
              center: null,
              right: null,
            },
          },
        ],
      },
    ]);
  });

  press('center');
  release('center');
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('RECORDING'));
  press('center');
  release('center');
  await waitFor(() => expect(phaseTitle()).toHaveTextContent(/result/i), {
    timeout: 5000,
  });
  press('left');
  release('left');

  await waitFor(() => expect(hud('left').textContent).toBe('Unassigned'));
  press('left');
  release('left');
  await waitFor(() => expect(toastSays('LEFT is unassigned')).toBe(true));
  expect(reviewBodies).toHaveLength(0);
});

test('a legacy persisted label-only context stays unassigned rather than guessing', async () => {
  window.localStorage.setItem(
    'kairos.collect.batch',
    JSON.stringify({
      batchSeq: null,
      recordedCount: 0,
      batchId: null,
      episodes: [],
      project: 'Tabletop',
      task: 'Pick and Place',
      condition: '—',
      lastCaptureId: null,
    }),
  );
  __rehydrateBatchStore();
  renderWithClient(<CollectScreen />);
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));

  press('center');
  release('center');
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('RECORDING'));
  press('center');
  release('center');
  await waitFor(() => expect(phaseTitle()).toHaveTextContent(/result/i), {
    timeout: 5000,
  });
  press('left');
  release('left');

  await waitFor(() => expect(hud('left').textContent).toBe('Unassigned'));
  expect(screen.queryByTestId('ext-action-task-name')).not.toBeInTheDocument();
});

test('task switch changes the displayed AND effective reasons mid-batch', async () => {
  renderWithClient(<CollectScreen />);
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));
  press('center');
  release('center');
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('RECORDING'));
  press('center');
  release('center');
  await waitFor(() => expect(phaseTitle()).toHaveTextContent(/result/i), {
    timeout: 5000,
  });

  // The context is locked while the result is open; save the take first.
  press('right');
  release('right');
  await waitFor(() => expect(recorded()).toHaveTextContent('1'));

  // Switching task once the set holds a recording closes the set (rollover)
  // and re-resolves the shortcuts for the new task.
  fireEvent.click(screen.getByTitle('Change task (from plan)'));
  fireEvent.click(await screen.findByRole('button', { name: 'Stacking' }));
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));

  // Record a second take under the new task and fail it: LEFT is now
  // "Robot fault", not "Grasp missed".
  press('center');
  release('center');
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('RECORDING'));
  press('center');
  release('center');
  await waitFor(() => expect(phaseTitle()).toHaveTextContent(/result/i), {
    timeout: 5000,
  });
  press('left');
  release('left');
  await waitFor(() => expect(hud('left').textContent).toBe('Robot fault'));
  press('left');
  release('left');
  // A rollover starts a NEW set, so the count restarts at 1 — the proof is in
  // the two review bodies: the first was Success, the second is the NEW
  // task's LEFT reason.
  await waitFor(() => expect(reviewBodies).toHaveLength(2), { timeout: 8000 });
  await waitFor(() => expect(recorded()).toHaveTextContent('1'), { timeout: 8000 });
  expect(JSON.parse(String(reviewBodies[0])).task_result).toBe('success');
  expect(JSON.parse(String(reviewBodies[1])).task_result).toBe('failure');
  expect(JSON.parse(String(reviewBodies[1])).failure_reason).toBe('Robot fault');
}, 20000);

test('failure-reason actions cannot fire before Failure is selected', async () => {
  renderWithClient(<CollectScreen />);
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));

  // READY: the sides are disabled — no reason can be stamped from here.
  press('left');
  release('left');
  press('right');
  release('right');
  expect(phaseTitle()).toHaveTextContent('READY');
  expect(reviewBodies).toHaveLength(0);

  // …and once RESULT arrives with Success pre-selected, LEFT means "select
  // Failure", not "save the LEFT reason".
  press('center');
  release('center');
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('RECORDING'));
  press('center');
  release('center');
  await waitFor(() => expect(phaseTitle()).toHaveTextContent(/result/i), {
    timeout: 5000,
  });
  press('left');
  release('left');
  expect(reviewBodies).toHaveLength(0); // selected Failure, did NOT save
  expect(hud('left').textContent).toBe('Grasp missed'); // now the reasons show
});

test('a held / repeating key cannot double-fire', async () => {
  renderWithClient(<CollectScreen />);
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));

  // Latch: start (keydown) without releasing, then a second keydown of the
  // same slot — it must NOT become a Stop for the just-started take.
  press('center');
  press('center');
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('RECORDING'));
  expect(phaseTitle()).toHaveTextContent('RECORDING');

  release('center');
  // Auto-repeat events (a still-held pedal) are ignored outright.
  press('center', { repeat: true });
  press('center', { repeat: true });
  expect(phaseTitle()).toHaveTextContent('RECORDING');

  // A fresh press after keyup stops exactly once.
  press('center');
  release('center');
  await waitFor(() => expect(phaseTitle()).toHaveTextContent(/result/i), {
    timeout: 5000,
  });
  press('right');
  press('right', { repeat: true }); // held during the save
  release('right');
  await waitFor(() => expect(recorded()).toHaveTextContent('1'));
  expect(reviewBodies).toHaveLength(1);
});

test('releasing the modifiers BEFORE the digit still un-latches the slot', async () => {
  renderWithClient(<CollectScreen />);
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));

  // Press CENTER and let the take start — the slot latches on keydown.
  press('center');
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('RECORDING'));

  // The exact release ordering that latched the slot forever: on a real
  // keyboard Ctrl and Alt come UP before the digit, so the Digit2 keyup
  // arrives with NO modifier flags. The latch must release on the physical
  // key alone — matching the chord on keyup would swallow every later press.
  fireEvent.keyUp(window, { key: 'Control', code: 'ControlLeft' });
  fireEvent.keyUp(window, { key: 'Alt', code: 'AltLeft' });
  fireEvent.keyUp(window, { key: '2', code: 'Digit2' });

  // The next fresh press must still act: STOP the running take.
  press('center');
  release('center');
  await waitFor(() => expect(phaseTitle()).toHaveTextContent(/result/i), {
    timeout: 5000,
  });

  // …and the latch stays healthy across a full cycle afterwards.
  press('right');
  release('right');
  await waitFor(() => expect(recorded()).toHaveTextContent('1'));
  press('center');
  release('center');
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('RECORDING'));
});

test('window blur clears a held external-action latch', async () => {
  renderWithClient(<CollectScreen />);
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));

  // Start without a keyup, then leave the browser window. Browsers can omit
  // keyup on focus loss, so returning must not swallow this new STOP press.
  press('center');
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('RECORDING'));
  fireEvent.blur(window);
  press('center');
  release('center');
  await waitFor(() => expect(phaseTitle()).toHaveTextContent(/result/i), {
    timeout: 5000,
  });
});

test('typing, modal, saving and takeover states suppress the chords', async () => {
  renderWithClient(<CollectScreen />);
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));

  // Typing: a keydown while an input is focused targets that input and
  // bubbles to the window listener — the guard must read it as data, not a
  // command (dispatched to the input, exactly like a browser does).
  const typing = document.createElement('input');
  document.body.appendChild(typing);
  typing.focus();
  fireEvent.keyDown(typing, { key: '2', code: 'Digit2', ctrlKey: true, altKey: true });
  fireEvent.keyUp(typing, { key: '2', code: 'Digit2', ctrlKey: true, altKey: true });
  typing.remove();
  expect(phaseTitle()).toHaveTextContent('READY');

  // Modal: the shortcuts sheet is an overlay; the chords wait behind it.
  fireEvent.keyDown(window, { key: '?' });
  await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
  press('center');
  release('center');
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(phaseTitle()).toHaveTextContent('READY');

  // Saving: a delayed stop keeps the machine in SAVING, where nothing fires.
  press('center');
  release('center');
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('RECORDING'));
  stopDelayMs = 400;
  press('center');
  release('center');
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('SAVING'));
  press('right');
  release('right');
  press('left');
  release('left');
  expect(reviewBodies).toHaveLength(0);
  await waitFor(() => expect(phaseTitle()).toHaveTextContent(/result/i), {
    timeout: 5000,
  });
  expect(reviewBodies).toHaveLength(0); // the chords never saved during SAVING
  // …and the flow still completes with a normal press afterwards.
  press('right');
  release('right');
  await waitFor(() => expect(recorded()).toHaveTextContent('1'));
});

test('takeover suppresses the chords', async () => {
  // A recording is live on a capture this screen never started → takeover.
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/config/options')) {
      return Promise.resolve(
        jsonResponse({ active_robot: 'r', robots: [], aspects: {} }),
      );
    }
    if (url.match(/\/captures\//)) {
      return Promise.resolve(
        jsonResponse({
          ...completed('recording'),
          capture_id: OTHER_CAP,
          run_id: 'run_other',
        }),
      );
    }
    if (url.includes('/record/status')) {
      return Promise.resolve(
        jsonResponse({
          run_id: 'run_other',
          capture_id: OTHER_CAP,
          state: 'recording',
          live_capture_ids: [OTHER_CAP],
        }),
      );
    }
    if (url.includes('/config')) return Promise.resolve(jsonResponse(CONFIG));
    return Promise.resolve(jsonResponse({}));
  });
  renderWithClient(<CollectScreen />);
  // The takeover card's title is "RECORDING IN PROGRESS" (the live recording
  // is not ours — the card names the situation, not the word "takeover").
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('RECORDING IN PROGRESS'));

  // The HUD shows everything disabled during a takeover…
  expect(hud('center').textContent).toBe('—');
  // …and a CENTER press neither starts nor stops anything.
  press('center');
  release('center');
  expect(startCalls).toBe(0);
  expect(phaseTitle()).toHaveTextContent('RECORDING IN PROGRESS');
});

test('the existing R / S / ? flow is unchanged alongside the new chords', async () => {
  renderWithClient(<CollectScreen />);
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));
  fireEvent.keyDown(window, { key: 'r' });
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('RECORDING'));
  fireEvent.keyDown(window, { key: 's' });
  await waitFor(() => expect(phaseTitle()).toHaveTextContent(/result/i), {
    timeout: 5000,
  });
  // The chords still do their part on the same screen: RIGHT saves Success.
  press('right');
  release('right');
  await waitFor(() => expect(recorded()).toHaveTextContent('1'));
  expect(reviewBody().task_result).toBe('success');
});
