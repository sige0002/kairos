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

// Like mockFetch but with a controllable GET /record/status body — the real
// source of the arming note + integrity banner.
function mockFetchWithStatus(opts: {
  start?: Record<string, unknown>;
  status?: Record<string, unknown>;
}) {
  const start = opts.start ?? { run_id: 'run_1', state: 'recording' };
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/record/status')) return Promise.resolve(jsonResponse(opts.status ?? {}));
    if (url.includes('/record/start')) return Promise.resolve(jsonResponse(start));
    if (url.includes('/record/stop')) return Promise.resolve(jsonResponse({ run_id: 'run_1', state: 'completed' }));
    if (url.includes('/config')) return Promise.resolve(jsonResponse(CONFIG));
    return Promise.resolve(jsonResponse({}));
  });
}

async function driveToResult() {
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));
  fireEvent.click(screen.getByRole('button', { name: /Start recording/ }));
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('RECORDING'));
  fireEvent.click(screen.getByRole('button', { name: /Stop recording/ }));
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('Episode 1 result'), { timeout: 4000 });
}

function phaseTitle() {
  return screen.getByTestId('phase-title');
}

beforeEach(() => {
  setApiBase('/api/v1');
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

// Real drop/integrity banner (v1 parity, OL-①): a run that stopped with
// integrity 'dropped' shows the amber "Data dropped — N messages lost" banner
// with the cache hint, driven by the REAL /record/status — not the mock quality
// path. A quick stop (<6s) keeps the mock chip at QUICK: GOOD, proving the two
// signals are independent and the banner is the dominant, real one.
test('result phase shows the real drop banner (dropped_messages) from /record/status', async () => {
  mockFetchWithStatus({
    status: { run_id: 'run_1', state: 'completed', integrity: 'dropped', dropped_messages: 1234 },
  });
  renderWithClient(<CollectScreen />);
  await driveToResult();

  const banner = screen.getByTestId('integrity-banner');
  expect(banner).toHaveTextContent(/Data dropped — 1[.,]?234 messages lost/);
  expect(banner).toHaveTextContent('raise max_cache_size_mb');
  // The mock quality path is separate and does NOT drive this banner: a quick
  // stop keeps QUICK: GOOD while the real drop banner still dominates.
  expect(screen.getByText('QUICK: GOOD')).toBeInTheDocument();
});

test('result phase shows the real "Recording failed" banner when integrity is failed', async () => {
  mockFetchWithStatus({
    status: { run_id: 'run_1', state: 'failed', integrity: 'failed' },
  });
  renderWithClient(<CollectScreen />);
  await driveToResult();

  const banner = screen.getByTestId('integrity-banner');
  expect(banner).toHaveTextContent('Recording failed — bag unreadable');
});

// The mock quality path must never fabricate a drop/integrity banner: an 'ok'
// run reaches the result with QUICK: GOOD and no banner.
test('no integrity banner when the run integrity is ok', async () => {
  mockFetchWithStatus({
    status: { run_id: 'run_1', state: 'completed', integrity: 'ok' },
  });
  renderWithClient(<CollectScreen />);
  await driveToResult();

  expect(screen.getByText('QUICK: GOOD')).toBeInTheDocument();
  expect(screen.queryByTestId('integrity-banner')).toBeNull();
});

test('recording phase shows the real arming matched/missing note from /record/status', async () => {
  mockFetchWithStatus({
    status: {
      run_id: 'run_1',
      state: 'recording',
      arming: {
        active: false,
        matched_topics: ['/a', '/b', '/c'],
        missing_topics: ['/cam/right', '/lidar'],
      },
    },
  });
  renderWithClient(<CollectScreen />);
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));
  fireEvent.click(screen.getByRole('button', { name: /Start recording/ }));
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('RECORDING'));

  const note = await screen.findByTestId('arming-note');
  expect(note).toHaveTextContent('3 matched');
  expect(note).toHaveTextContent('2 missing');
  expect(note).toHaveTextContent('/cam/right');
});

// Record-topic selection chip: shows the real resolved count and navigates to
// Monitor (where the picker lives). CONFIG has no default_topics and the store
// is not customized → "all topics".
test('ContextBar shows the REC topics chip and navigates to Monitor on click', async () => {
  mockFetch({ run_id: 'run_1', state: 'recording' });
  renderWithClient(<CollectScreen />);
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));

  const chip = screen.getByTestId('rec-topics-chip');
  expect(chip).toHaveTextContent('REC all topics');
  fireEvent.click(chip);
  await waitFor(() => expect(useUiStore.getState().activeTab).toBe('monitor'));
});

// Real Discard: the result-phase "Discard & re-record" opens a confirmation
// modal, then DELETE /api/v1/runs/{run_id} actually removes the run before the
// local re-record reset (v1 LiveTab Keep/Discard parity).
test('Discard & re-record confirms, then deletes the run via DELETE /runs/{id}', async () => {
  const fetchSpy = mockFetchWithStatus({
    status: { run_id: 'run_1', state: 'completed', integrity: 'ok', bytes: 1048576 },
  });
  renderWithClient(<CollectScreen />);
  await driveToResult();

  fireEvent.click(screen.getByRole('button', { name: /Discard & re-record this episode/ }));
  const confirm = await screen.findByRole('button', { name: /Discard permanently/ });
  fireEvent.click(confirm);

  await waitFor(() => {
    const del = fetchSpy.mock.calls.find(
      ([u, i]) => String(u).includes('/runs/run_1') && i?.method === 'DELETE',
    );
    expect(del).toBeTruthy();
  });
  // After a successful delete the batch re-arms for a fresh take of this episode.
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));
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
