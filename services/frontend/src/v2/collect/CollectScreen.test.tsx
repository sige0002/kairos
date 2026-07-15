import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { useUiStore } from '../../store/uiStore';
import { CollectScreen } from './CollectScreen';
import { __resetBatchStore } from './useBatchMachine';
import { __resetCameraStore } from './cameraStore';
import { __clearEpisodeOutcomes } from '../episodeBridge';
import { __resetPlansStore, clonePlans, getPlans, setPlans } from '../plans';

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
// source of the arming note + integrity banner. The status reports idle UNTIL
// the operator starts here, so the test's own start flow isn't mistaken for a
// takeover (a server recording we didn't start); afterwards it returns `status`.
function mockFetchWithStatus(opts: {
  start?: Record<string, unknown>;
  status?: Record<string, unknown>;
  /** Body for the result-panel `GET /runs/{id}` quick_check poll (F1). */
  detail?: Record<string, unknown>;
}) {
  const start = opts.start ?? { run_id: 'run_1', state: 'recording' };
  let started = false;
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/record/status'))
      return Promise.resolve(
        jsonResponse(started ? (opts.status ?? {}) : { run_id: null, state: 'idle' }),
      );
    if (url.includes('/record/start')) {
      started = true;
      return Promise.resolve(jsonResponse(start));
    }
    if (url.includes('/record/stop')) return Promise.resolve(jsonResponse({ run_id: 'run_1', state: 'completed' }));
    if (url.includes('/config')) return Promise.resolve(jsonResponse(CONFIG));
    // GET /runs/{id} detail — the result-panel quick_check poll (F1).
    if (/\/runs\/[^/?]+/.test(url))
      return Promise.resolve(
        jsonResponse({ run_id: 'run_1', state: 'completed', ...(opts.detail ?? {}) }),
      );
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
  // The batch machine is a module-level store (survives tab-switch unmounts);
  // reset it (and its localStorage mirror) so a recorded episode in one test
  // can't leak into the next test's fresh CollectScreen.
  // Reset the shared plans store BEFORE the batch store — the machine's initial
  // project/task/condition seed from the (now clean) catalog.
  __resetPlansStore();
  __resetBatchStore();
  // The camera panes live in a module store too — reset so a prior test's panes
  // can't leak into the next CollectScreen render.
  __resetCameraStore();
  // A confirmed episode now mirrors into the Collect->Review bridge; clear it
  // between tests so nothing accumulates across cases.
  __clearEpisodeOutcomes();
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

test('Stop recording moves to SAVING and shows the honest finalizing copy', async () => {
  // The stop hangs and the recorder keeps reporting the run as still recording,
  // so SAVING persists — proving it waits on the real stop event (D-3), not a
  // fixed timer. Status is idle until we start (avoids the takeover path).
  let started = false;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/config')) return Promise.resolve(jsonResponse(CONFIG));
    if (url.includes('/record/start')) {
      started = true;
      return Promise.resolve(jsonResponse({ run_id: 'run_1', state: 'recording' }));
    }
    if (url.includes('/record/status'))
      return Promise.resolve(
        jsonResponse(started ? { run_id: 'run_1', state: 'recording' } : { run_id: null, state: 'idle' }),
      );
    if (url.includes('/record/stop')) return new Promise(() => {}); // never resolves
    return Promise.resolve(jsonResponse({}));
  });
  renderWithClient(<CollectScreen />);

  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));
  fireEvent.click(screen.getByRole('button', { name: /Start recording/ }));
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('RECORDING'));

  fireEvent.click(screen.getByRole('button', { name: /Stop recording/ }));
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('SAVING…'));
  // Honest, non-fabricated copy (no fake MB/percent).
  expect(screen.getByText('Finalizing the recording…')).toBeInTheDocument();
});

// Persona finding P1/P4: a failed TASK must not read as "not usable" data, and
// the operator must see the task outcome in plain language before saving. Quality
// is now the real quick-check (integrity 'ok' → Good), not a fabricated warning.
test('a failed task on a clean recording stays good quality; the single Save action reflects the outcome', async () => {
  mockFetchWithStatus({
    status: { run_id: 'run_1', state: 'completed', integrity: 'ok' },
  });
  renderWithClient(<CollectScreen />);
  await driveToResult();

  // Success is pre-selected on entry → the primary is a single "Save — success".
  expect(screen.getByRole('button', { name: /Save — success/ })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /Failure/ }));
  // No reason yet → Save is the failure variant and the summary prompts for one.
  expect(screen.getByTestId('episode-summary')).toHaveTextContent(
    'Task outcome: Failed — choose a reason below.',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Object dropped' }));
  expect(screen.getByTestId('episode-summary')).toHaveTextContent('Task outcome: Failed — object dropped.');

  fireEvent.click(screen.getByRole('button', { name: /Save — failure/ }));

  // The core P1 fix: a failed task still counts as good-quality, usable data —
  // never lumped into a quality "not usable"/fail bucket.
  await waitFor(() => expect(screen.getByTestId('stat-good')).toHaveTextContent('1'));
  expect(screen.getByTestId('stat-review')).toHaveTextContent('0');
  expect(screen.getByTestId('stat-task-failed')).toHaveTextContent('1');
});

// D-2: the QUICK chip and quality line reflect the REAL integrity — no fabricated
// "camera rate dropped". A clean run defaults to Good · auto; the operator can
// override to Not usable (which becomes the honest 'operator' provenance).
test('result panel shows honest auto quality and an operator override', async () => {
  mockFetchWithStatus({ status: { run_id: 'run_1', state: 'completed', integrity: 'ok' } });
  renderWithClient(<CollectScreen />);
  await driveToResult();

  expect(screen.getByText('QUICK: GOOD')).toBeInTheDocument();
  expect(screen.getByText(/Good/)).toBeInTheDocument();
  expect(screen.getByText('· auto')).toBeInTheDocument();

  // Expand the override chips and choose Not usable.
  fireEvent.click(screen.getByRole('button', { name: 'change' }));
  fireEvent.click(screen.getByRole('button', { name: 'Not usable' }));
  // The "· auto" provenance is gone once the operator overrides.
  expect(screen.queryByText('· auto')).toBeNull();
});

// Real drop/integrity banner (v1 parity, OL-①): a run that stopped with
// integrity 'dropped' shows the amber "Data dropped — N messages lost" banner
// with the cache hint, driven by the REAL /record/status. Now the QUICK chip is
// DERIVED from that same real integrity (D-2), so a dropped run reads NEEDS
// REVIEW — the chip and the banner agree because they share one honest source.
test('result phase shows the real drop banner and a matching NEEDS REVIEW chip', async () => {
  mockFetchWithStatus({
    status: { run_id: 'run_1', state: 'completed', integrity: 'dropped', dropped_messages: 1234 },
  });
  renderWithClient(<CollectScreen />);
  await driveToResult();

  const banner = screen.getByTestId('integrity-banner');
  expect(banner).toHaveTextContent(/Data dropped — 1[.,]?234 messages lost/);
  expect(banner).toHaveTextContent('raise max_cache_size_mb');
  expect(screen.getByText('QUICK: NEEDS REVIEW')).toBeInTheDocument();
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

// F1 (settled): when the server verdict is needs_review, the result panel shows
// its plain-language reasons verbatim and the chip reads NEEDS REVIEW even
// though the recorder integrity is 'ok' (the verdict is the authority).
test('result panel shows the settled quick-check reasons and a NEEDS REVIEW chip', async () => {
  mockFetchWithStatus({
    status: { run_id: 'run_1', state: 'completed', integrity: 'ok' },
    detail: {
      quick_check: {
        verdict: {
          quality: 'needs_review',
          reasons: ['/hsrb/hand_camera/image_raw/compressed avg 9.982Hz < expected 30Hz'],
        },
      },
    },
  });
  renderWithClient(<CollectScreen />);
  await driveToResult();

  const reasons = await screen.findByTestId('quickcheck-reasons');
  expect(reasons).toHaveTextContent('9.982Hz < expected 30Hz');
  expect(screen.getByText('QUICK: NEEDS REVIEW')).toBeInTheDocument();
  // The settled verdict displaced the "running…" note.
  expect(screen.queryByTestId('quickcheck-pending')).toBeNull();
});

// F1 (unsettled): while the verdict is still settling (no quick_check on the
// run detail yet), the panel shows an honest subtle "Quick check running…" note
// and never blocks Save.
test('result panel shows a running note while the quick-check verdict is unsettled', async () => {
  mockFetchWithStatus({
    status: { run_id: 'run_1', state: 'completed', integrity: 'ok' },
    // detail omitted -> GET /runs/{id} returns no quick_check (unsettled).
  });
  renderWithClient(<CollectScreen />);
  await driveToResult();

  expect(await screen.findByTestId('quickcheck-pending')).toHaveTextContent(
    'Quick check running…',
  );
  // Saving is never gated on settlement — the primary Save is enabled.
  expect(screen.getByRole('button', { name: /Save — success/ })).toBeEnabled();
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

// ---------------------------------------------------------------------------
// Shared plans store: a Settings edit must reflect in Collect's pickers, and a
// removed selection must degrade gracefully (no crash).
// ---------------------------------------------------------------------------

test('a project added to the shared store appears in the Collect project picker', async () => {
  mockFetch({ run_id: 'run_1', state: 'recording' });
  // Simulate a Settings edit: add a project to the shared catalog.
  setPlans([...clonePlans(getPlans()), { name: 'Warehouse Sort', tasks: [{ name: 'Sort', conditions: ['Bin: A'] }] }]);
  renderWithClient(<CollectScreen />);
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));

  // Open the project picker; the newly-added project is listed immediately.
  fireEvent.click(screen.getByTitle('Change project (from plan)'));
  expect(screen.getByRole('button', { name: 'Warehouse Sort' })).toBeInTheDocument();
});

// Free-text task (v1 parity): the "Custom…" Task-picker entry prompts for any
// string and flows it into the real /record/start body — without adding it to
// the shared plans catalog.
test('a custom task typed via the Task picker flows into the /record/start body', async () => {
  const fetchSpy = mockFetch({ run_id: 'run_1', state: 'recording' });
  vi.spyOn(window, 'prompt').mockReturnValue('Fold the towel');
  renderWithClient(<CollectScreen />);
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));

  fireEvent.click(screen.getByTitle('Change task (from plan)'));
  fireEvent.click(screen.getByRole('button', { name: /Custom/ }));

  // Shown as the selected task, and NOT added to the plans catalog.
  await waitFor(() => expect(screen.getByText('Fold the towel')).toBeInTheDocument());
  expect(getPlans().some((p) => p.tasks.some((t) => t.name === 'Fold the towel'))).toBe(false);

  fireEvent.click(screen.getByRole('button', { name: /Start recording/ }));
  await waitFor(() => {
    const start = fetchSpy.mock.calls.find((c) => String(c[0]).includes('/record/start'));
    expect(start).toBeTruthy();
    expect(JSON.parse(String((start![1] as RequestInit).body)).task).toBe('Fold the towel');
  });
});

test('Collect degrades gracefully when its selected project is absent from the store', async () => {
  mockFetch({ run_id: 'run_1', state: 'recording' });
  // The machine seeded its project from the default catalog; now replace the
  // catalog so that selection no longer exists (as if it were removed/renamed).
  setPlans([{ name: 'Only Project', tasks: [{ name: 'Only Task', conditions: ['Only Cond'] }] }]);
  renderWithClient(<CollectScreen />);

  // Still renders (no crash); the orphaned selection stays shown as-is, and the
  // task picker falls back to the surviving project's tasks.
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));
  expect(screen.getByText('Tabletop Manipulation')).toBeInTheDocument();
  fireEvent.click(screen.getByTitle('Change task (from plan)'));
  expect(screen.getByRole('button', { name: 'Only Task' })).toBeInTheDocument();
});

test('Batch menu → Reset batch on an empty batch is a no-op (honest wording)', async () => {
  mockFetch({ run_id: 'run_1', state: 'recording' });
  renderWithClient(<CollectScreen />);
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));
  // No recording yet → no server batch → the Batch cell shows an honest, muted
  // prediction of the next number instead of a bare "—".
  expect(screen.getByText(/assigned on first recording/)).toBeInTheDocument();
  expect(screen.queryByText('Batch —')).toBeNull();

  fireEvent.click(screen.getByText('Batch menu'));
  fireEvent.click(screen.getByText('Reset batch…'));

  // Empty batch → no-number title + no-op wording (nothing created or closed).
  expect(screen.getByText('Reset batch?')).toBeInTheDocument();
  expect(screen.getByText(/Nothing has been recorded/)).toBeInTheDocument();

  fireEvent.click(screen.getByTestId('reset-batch-confirm'));
  await waitFor(() => expect(screen.queryByText('Reset batch?')).toBeNull());
  // Still the prediction pre-state: an empty reset never allocates a number.
  expect(screen.getByText(/assigned on first recording/)).toBeInTheDocument();
  expect(screen.queryByText('Batch —')).toBeNull();
});

// ---------------------------------------------------------------------------
// D-1 takeover: a server recording this screen isn't driving replaces READY.
// ---------------------------------------------------------------------------

test('a server recording surfaces the takeover card instead of READY, and Stop confirms first', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/config')) return Promise.resolve(jsonResponse(CONFIG));
    if (url.includes('/runs/run_ext'))
      return Promise.resolve(
        jsonResponse({ run_id: 'run_ext', state: 'recording', topics: [{ name: '/a', type: 'x' }], operator: 'other' }),
      );
    if (url.includes('/record/status'))
      return Promise.resolve(
        jsonResponse({ run_id: 'run_ext', state: 'recording', started_at: new Date().toISOString(), bytes: 4096 }),
      );
    return Promise.resolve(jsonResponse({}));
  });
  renderWithClient(<CollectScreen />);

  await waitFor(() => expect(phaseTitle()).toHaveTextContent('RECORDING IN PROGRESS'));
  expect(screen.getByText(/wasn't started from this screen/)).toBeInTheDocument();
  // The primary action opens a confirmation (use-error guard), not an instant stop.
  fireEvent.click(screen.getByRole('button', { name: /Stop recording/ }));
  expect(await screen.findByText('Stop this recording?')).toBeInTheDocument();
});

// ---------------------------------------------------------------------------
// D-3 unsaved-take recovery banner.
// ---------------------------------------------------------------------------

test('an unsaved completed take shows the recovery banner with Label / Discard / Later', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/config')) return Promise.resolve(jsonResponse(CONFIG));
    if (url.includes('/runs'))
      return Promise.resolve(
        jsonResponse({
          items: [
            {
              run_id: 'run_u',
              state: 'completed',
              started_at: new Date(Date.now() - 60_000).toISOString(),
              ended_at: new Date().toISOString(),
            },
          ],
          next_cursor: null,
        }),
      );
    return Promise.resolve(jsonResponse({}));
  });
  renderWithClient(<CollectScreen />);

  const banner = await screen.findByTestId('unsaved-take-banner');
  expect(banner).toHaveTextContent(/Unsaved take from/);
  expect(banner).toHaveTextContent(/Label it now, or discard it\./);
  expect(within(banner).getByRole('button', { name: 'Label it' })).toBeInTheDocument();
  expect(within(banner).getByRole('button', { name: 'Discard' })).toBeInTheDocument();
  expect(within(banner).getByRole('button', { name: 'Later' })).toBeInTheDocument();

  // "Later" dismisses it for this page load.
  fireEvent.click(within(banner).getByRole('button', { name: 'Later' }));
  await waitFor(() => expect(screen.queryByTestId('unsaved-take-banner')).toBeNull());
});

// ---------------------------------------------------------------------------
// D-4 keyboard & focus.
// ---------------------------------------------------------------------------

test('focus follows the phase — Start on ready, Save on result (no focus falls to body)', async () => {
  mockFetchWithStatus({ status: { run_id: 'run_1', state: 'completed', integrity: 'ok' } });
  renderWithClient(<CollectScreen />);
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Start recording/ })),
  );

  await driveToResult();
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Save — success/ })),
  );
});

test('keyboard shortcuts: R starts and S stops, but typing in an input is ignored', async () => {
  mockFetch({ run_id: 'run_1', state: 'recording' });
  renderWithClient(<CollectScreen />);
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));

  // Typing R into an input must NOT start recording.
  const input = document.createElement('input');
  document.body.appendChild(input);
  input.focus();
  fireEvent.keyDown(input, { key: 'r' });
  expect(phaseTitle()).toHaveTextContent('READY');
  input.remove();

  // R on the page starts recording…
  fireEvent.keyDown(document.body, { key: 'r' });
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('RECORDING'));
  // …and S stops it (leaves the recording phase).
  fireEvent.keyDown(document.body, { key: 's' });
  await waitFor(() => expect(phaseTitle()).not.toHaveTextContent('RECORDING'));
});

test('the ? shortcut opens the keyboard-shortcuts sheet', async () => {
  mockFetch({ run_id: 'run_1', state: 'recording' });
  renderWithClient(<CollectScreen />);
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));
  fireEvent.keyDown(document.body, { key: '?' });
  expect(await screen.findByText('Keyboard shortcuts')).toBeInTheDocument();
});
