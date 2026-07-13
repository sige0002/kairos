import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { useUiStore } from '../../store/uiStore';
import { CollectScreen } from './CollectScreen';

const CONFIG = {
  endpoints: { api: '/api/v1', events: '/api/v1/events', webrtc: 'http://localhost:8002' },
  tabs: [],
  defaults: { default_topics: [] },
  schemas: {},
};

function mockFetch(recordStartBody: Record<string, unknown>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/config')) return Promise.resolve(jsonResponse(CONFIG));
    if (url.includes('/record/start')) return Promise.resolve(jsonResponse(recordStartBody));
    if (url.includes('/record/stop')) return Promise.resolve(jsonResponse({ run_id: 'run_1', state: 'completed' }));
    return Promise.resolve(jsonResponse({}));
  });
}

function phaseTitle() {
  return screen.getByTestId('phase-title');
}

beforeEach(() => {
  setApiBase('/api/v1');
  useUiStore.setState({ activeTab: '', sseStatus: 'closed', monitorBridge: null });
});
afterEach(() => vi.restoreAllMocks());

test('READY phase: shows the Start recording control and context bar', async () => {
  mockFetch({ run_id: 'run_1', state: 'recording' });
  renderWithClient(<CollectScreen />);

  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));
  expect(screen.getByRole('button', { name: /Start recording/ })).toBeInTheDocument();
  // Context bar cells.
  expect(screen.getByText('Tabletop Manipulation')).toBeInTheDocument();
  expect(screen.getByText('Pick and Place')).toBeInTheDocument();
  // Episode strip.
  expect(screen.getByTestId('episode-strip-count')).toHaveTextContent('0 / 30');
});

test('Start recording arms, then flips to RECORDING once /record/start succeeds', async () => {
  mockFetch({ run_id: 'run_1', state: 'recording' });
  renderWithClient(<CollectScreen />);

  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));
  fireEvent.click(screen.getByRole('button', { name: /Start recording/ }));

  await waitFor(() => expect(phaseTitle()).toHaveTextContent('ARMING…'));
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('RECORDING'));
  expect(screen.getByRole('button', { name: /Stop recording/ })).toBeInTheDocument();
});

test('a rejected start shows the failed banner and stays on READY', async () => {
  mockFetch({
    run_id: 'run_1',
    state: 'failed',
    error: { code: 'NO_TOPICS', message: 'no matching topics' },
  });
  renderWithClient(<CollectScreen />);

  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));
  fireEvent.click(screen.getByRole('button', { name: /Start recording/ }));

  await waitFor(() => expect(screen.getByText(/NO_TOPICS/)).toBeInTheDocument());
  expect(phaseTitle()).toHaveTextContent('READY');
});

test('Stop recording moves to SAVING', async () => {
  mockFetch({ run_id: 'run_1', state: 'recording' });
  renderWithClient(<CollectScreen />);

  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));
  fireEvent.click(screen.getByRole('button', { name: /Start recording/ }));
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('RECORDING'));

  fireEvent.click(screen.getByRole('button', { name: /Stop recording/ }));
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('SAVING…'));
});

// Persona finding P1/P4: a failed TASK must not read as "not usable" data,
// and the operator must see both dimensions in plain language before saving.
test('a failed task with no quality warning shows the plain-language summary and keeps good quality in the stats', async () => {
  mockFetch({ run_id: 'run_1', state: 'recording' });
  renderWithClient(<CollectScreen />);

  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));
  fireEvent.click(screen.getByRole('button', { name: /Start recording/ }));
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('RECORDING'));
  // Stop well before the 6s review-warning threshold, so quality stays 'good'.
  fireEvent.click(screen.getByRole('button', { name: /Stop recording/ }));
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('Episode 1 result'), { timeout: 4000 });

  fireEvent.click(screen.getByRole('button', { name: /Failure/ }));
  // No summary until a fail reason is picked (Save stays disabled either way).
  expect(screen.getByTestId('episode-summary')).toHaveTextContent(
    'Task outcome: Failed — choose a reason below.',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Object dropped' }));

  const summary = screen.getByTestId('episode-summary');
  expect(summary).toHaveTextContent('Task outcome: Failed — object dropped.');
  expect(summary).toHaveTextContent('Recording quality: Good — no issues detected.');

  fireEvent.click(screen.getByRole('button', { name: /Save & ready for #2/ }));

  // The core P1 fix: a failed task still counts as good-quality, usable data —
  // never lumped into a quality "not usable"/fail bucket.
  await waitFor(() => expect(screen.getByTestId('stat-good')).toHaveTextContent('1'));
  expect(screen.getByTestId('stat-review')).toHaveTextContent('0');
  expect(screen.getByTestId('stat-task-failed')).toHaveTextContent('1');
});

test('Robot cell lists real robots and switches via POST /config/select', async () => {
  const OPTIONS = {
    active_robot: 'airoa_hsr',
    robots: [
      { id: 'airoa_hsr', local: false },
      { id: 'realman', local: false },
    ],
    aspects: {},
  };
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/config/options')) return Promise.resolve(jsonResponse(OPTIONS));
    if (url.includes('/config/select'))
      return Promise.resolve(jsonResponse({ ...OPTIONS, active_robot: 'realman' }));
    if (url.includes('/config')) return Promise.resolve(jsonResponse(CONFIG));
    return Promise.resolve(jsonResponse({}));
  });
  renderWithClient(<CollectScreen />);

  const cell = () => screen.getByTitle('Switch robot config (disabled while recording)');
  await waitFor(() => expect(cell()).toHaveTextContent('airoa_hsr'));

  fireEvent.click(cell());
  fireEvent.click(await screen.findByRole('button', { name: /realman/ }));

  await waitFor(() => {
    const call = fetchSpy.mock.calls.find((c) => String(c[0]).includes('/config/select'));
    expect(call).toBeTruthy();
    expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({
      category: 'robot',
      id: 'realman',
    });
  });
  // The cell reflects the response's new active robot (cache updated in place).
  await waitFor(() => expect(cell()).toHaveTextContent('realman'));
});
