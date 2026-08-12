// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// E-31: can a take be run end to end without a mouse, and does anything fire
// or lose focus when it should not?
//
// Two shapes, pulling opposite ways: a key that ACTS when it should not
// (Space/Enter on a screen with a destructive control, a shortcut firing while
// typing or under a modal), and focus landing NOWHERE after an action, leaving
// the next keypress to the document with no visible cursor.
//
// On the first: the guard covers the overlays REGISTERED with the machine, not
// every overlay on screen. That distinction is not pedantry — the Robot picker
// kept its open state in ContextBar and `r` started a take behind it (pinned in
// ContextBarRobotSwitch.test.tsx). The typing guard here is the other half.
//
// `@testing-library/user-event` is not a dependency here, so "press Enter on
// the focused control" is modelled as activating `document.activeElement` —
// which is what a browser does for a focused <button>. The window-level
// shortcuts (r / s / Escape / ?) are real keydown events, since those are
// literally what the product listens for.

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

const CAP_1 = '0192f0aa-3333-7000-8000-000000000003';
let recording = false;

function mockFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = (init as RequestInit)?.method ?? 'GET';
    if (url.includes('/config/options')) {
      return Promise.resolve(jsonResponse({ active_robot: 'r', robots: [], aspects: {} }));
    }
    if (url.includes('/record/start')) {
      recording = true;
      return Promise.resolve(jsonResponse(completed('recording')));
    }
    if (url.includes('/record/stop')) {
      recording = false;
      return Promise.resolve(jsonResponse(completed('completed')));
    }
    if (url.match(/\/captures\/[^/]+\/review/)) {
      return Promise.resolve(jsonResponse({ ...completed('completed'), review_revision: 1 }));
    }
    if (url.match(/\/captures\/[^/]+$/)) return Promise.resolve(jsonResponse(completed('completed')));
    if (url.includes('/record/status')) {
      return Promise.resolve(
        jsonResponse({
          run_id: recording ? 'run_x' : null,
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

function completed(state: string) {
  return {
    capture_id: CAP_1,
    run_id: 'run_20260805_130000',
    state,
    review_status: 'pending',
    review_revision: 0,
    integrity: 'ok',
    quick_check: 'ok',
  };
}

/** What a browser does when Enter is pressed on a focused <button>. */
function activateFocused() {
  const el = document.activeElement as HTMLElement | null;
  expect(el).not.toBe(document.body);
  fireEvent.click(el!);
}

/** The element that would receive the operator's next keystroke. */
function focused() {
  return document.activeElement as HTMLElement | null;
}

const phaseTitle = () => screen.getByTestId('phase-title');

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

test('a whole take runs on the keyboard, and focus is never left on the document', async () => {
  renderWithClient(<CollectScreen />);
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));

  // READY — focus is on Start, and `r` starts.
  expect(focused()).not.toBe(document.body);
  expect(focused()).toHaveAccessibleName(/Start recording/);
  fireEvent.keyDown(window, { key: 'r' });
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('RECORDING'));

  // RECORDING — focus followed to Stop, and `s` stops. Awaited because the
  // focus effect runs after the render that changed the phase.
  expect(focused()?.tagName).toBe('BUTTON');
  await waitFor(() => expect(focused()).toHaveAccessibleName(/Stop recording/));
  fireEvent.keyDown(window, { key: 's' });
  await waitFor(() => expect(phaseTitle()).toHaveTextContent(/result/i), { timeout: 5000 });

  // RESULT — focus followed to the primary action; activating it saves.
  expect(focused()).not.toBe(document.body);
  activateFocused();
  await waitFor(() => expect(screen.getByTestId('stat-recorded')).toHaveTextContent('1'));

  // …and the next take is reachable without touching the mouse.
  await waitFor(() => expect(focused()).toHaveAccessibleName(/Start recording/));
});

test('Space does not fire the shortcut while the operator is typing', async () => {
  renderWithClient(<CollectScreen />);
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));
  fireEvent.keyDown(window, { key: 'r' });
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('RECORDING'));

  // A note field is exactly where a stray Space would be typed, not commanded.
  const typing = document.createElement('input');
  document.body.appendChild(typing);
  typing.focus();
  fireEvent.keyDown(typing, { key: ' ' });
  fireEvent.keyDown(typing, { key: 's' });

  expect(phaseTitle()).toHaveTextContent('RECORDING');
  typing.remove();
});

test('a modal leaves focus somewhere usable, both while open and after closing', async () => {
  renderWithClient(<CollectScreen />);
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));

  // Reach a destructive dialog the way a keyboard operator would: activate the
  // Batch menu, then its item. The menu unmounts as the dialog opens, so
  // whatever had focus is gone from the document at that moment.
  fireEvent.click(screen.getByRole('button', { name: /Batch menu/ }));
  fireEvent.click(await screen.findByRole('button', { name: /End batch early/ }));
  const dialog = await screen.findByRole('dialog');

  // While the dialog is open, the next keystroke has to land INSIDE it —
  // otherwise Tab restarts from the top of the document behind the overlay.
  expect(dialog.contains(focused())).toBe(true);

  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

  // And on the way out focus must come back to a control, not the document.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(focused()).not.toBe(document.body);
});

test('a dialog that manages its own focus keeps it (the shared Modal defers)', async () => {
  // Several dialogs autoFocus the field they exist to have typed into. The
  // shared Modal focuses its container on open, and must NOT take focus off
  // that field — child effects run first, so by the time the Modal's effect
  // runs the input has already claimed focus and the container must stand down.
  renderWithClient(<CollectScreen />);
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));

  fireEvent.click(screen.getByRole('button', { name: /Batch menu/ }));
  fireEvent.click(await screen.findByRole('button', { name: /Change target/ }));

  const input = await screen.findByTestId('target-input');
  await waitFor(() => expect(focused()).toBe(input));
  // The operator can type immediately — which is the whole point of autoFocus.
  expect(focused()?.tagName).toBe('INPUT');
});
