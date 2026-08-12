// #11: a recording must be able to say who made it.
//
// Start used to be gated on the operator only once Settings held a roster, and
// the roster ships empty — so in the configuration everybody actually runs,
// nothing was gated and the orchestrator's `unknown_operator` placeholder was
// written into real captures. The gate now holds in every configuration, which
// makes this the first screen a new operator meets: it has to say what is
// wrong, point at the control that fixes it, and stay operable by keyboard
// while it is up.

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { useUiStore } from '../../store/uiStore';
import { CollectScreen } from './CollectScreen';
import { __resetCameraStore } from './cameraStore';
import { __resetPlansStore } from '../plans';
import { __resetBatchStore } from './useBatchMachine';
import { OPERATOR_GATE_HINT } from './machine/types';

const CONFIG = {
  endpoints: { api: '/api/v1', events: '/api/v1/events', webrtc: 'http://localhost:8002' },
  tabs: [],
  defaults: { default_topics: [] },
  schemas: {},
};

function mockFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/config')) return Promise.resolve(jsonResponse(CONFIG));
    if (url.includes('/record/start'))
      return Promise.resolve(
        jsonResponse({
          capture_id: 'cap_gate',
          run_id: 'run_cap_gate',
          state: 'recording',
          review_status: 'pending',
          review_revision: 0,
        }),
      );
    return Promise.resolve(jsonResponse({}));
  });
}

beforeEach(() => {
  setApiBase('/api/v1');
  __resetPlansStore();
  __resetBatchStore();
  __resetCameraStore();
  // The shipped default: no roster in Settings, and nobody named yet.
  useUiStore.setState({
    activeTab: '',
    sseStatus: 'closed',
    monitorBridge: null,
    recordOperator: '',
    recordSelected: new Set<string>(),
    recordCustomized: false,
  });
});

afterEach(() => vi.restoreAllMocks());

const start = () => screen.getByTestId('start-recording');

test('with no operator, Start is disabled and the note says why and where', async () => {
  mockFetch();
  renderWithClient(<CollectScreen />);
  await waitFor(() => expect(screen.getByTestId('phase-title')).toHaveTextContent('READY'));

  expect(start()).toBeDisabled();

  // Self-descriptive: the state, the control by the label printed on it, and
  // the reason it is worth the extra step.
  const note = screen.getByTestId('operator-gate-note');
  expect(note).toHaveTextContent('No name set yet');
  expect(note).toHaveTextContent('click OP at the top right');
  expect(note).toHaveTextContent('has to say who made it');

  // And the button POINTS at that note, so the reason is not merely nearby.
  expect(start().getAttribute('aria-describedby')).toBe(note.id);
});

// The gate is new in the default configuration, so this is the very first
// screen a new operator sees. A disabled button cannot take focus, and without
// somewhere to put it the console would open with focus on <body> — where the
// next Space press scrolls the page instead of reaching the flow (D-4).
test('focus does not fall to the document while the gate is up', async () => {
  mockFetch();
  renderWithClient(<CollectScreen />);
  await waitFor(() => expect(screen.getByTestId('phase-title')).toHaveTextContent('READY'));

  expect(document.activeElement).not.toBe(document.body);
  expect(screen.getByTestId('phase-title')).toHaveFocus();
});

test('naming an operator lifts the gate and hands focus to Start', async () => {
  mockFetch();
  renderWithClient(<CollectScreen />);
  await waitFor(() => expect(start()).toBeDisabled());

  // What the OP chip in the header does when a name is saved.
  useUiStore.setState({ recordOperator: 'tester' });

  await waitFor(() => expect(start()).toBeEnabled());
  expect(screen.queryByTestId('operator-gate-note')).not.toBeInTheDocument();
  expect(start()).not.toHaveAttribute('aria-describedby');
  // The control that just became usable is the one holding focus.
  await waitFor(() => expect(start()).toHaveFocus());
});

// R reaches startRecording without passing the disabled button, so the gate is
// checked in the machine too — the same belt-and-braces as the Stop floor and
// the arming-cancel guard.
test('the R shortcut is refused while the gate is up, and explains itself', async () => {
  const fetchMock = mockFetch();
  renderWithClient(<CollectScreen />);
  await waitFor(() => expect(screen.getByTestId('phase-title')).toHaveTextContent('READY'));

  fireEvent.keyDown(window, { key: 'r' });

  // Nothing started …
  expect(screen.getByTestId('phase-title')).toHaveTextContent('READY');
  expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/record/start'))).toBe(
    false,
  );
  // … and the keyboard path gets the SAME account as the button's note, rather
  // than reading as a dead key. It is announced, not just drawn: the toast
  // lives in the polite live region, which is the only way this reaches an
  // operator who is not looking at the card.
  await waitFor(() => {
    const announced = screen
      .getAllByRole('status')
      .some((region) => region.textContent?.includes(OPERATOR_GATE_HINT));
    expect(announced).toBe(true);
  });
  // Both surfaces, one string — the note and the toast cannot drift apart.
  expect(screen.getAllByText(OPERATOR_GATE_HINT)).toHaveLength(2);
});

test('the R shortcut works once an operator is named', async () => {
  const fetchMock = mockFetch();
  renderWithClient(<CollectScreen />);
  await waitFor(() => expect(start()).toBeDisabled());
  useUiStore.setState({ recordOperator: 'tester' });
  await waitFor(() => expect(start()).toBeEnabled());

  fireEvent.keyDown(window, { key: 'r' });

  await waitFor(() =>
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/record/start'))).toBe(
      true,
    ),
  );
});
