// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { useUiStore } from '../../store/uiStore';
import { CollectScreen } from './CollectScreen';
import {
  __rehydrateBatchStore,
  __resetBatchStore,
  __setStopFloorMs,
  __resetStopFloorMs,
} from './useBatchMachine';
import { __resetCameraStore } from './cameraStore';
import { __resetPlansStore, clonePlans, getPlans, setPlans } from '../plans';
import {
  expectHeadingSpine,
  expectScreenHeadingOutline,
} from '../../test/headingOutline';

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

// The capture the screen records in these tests. `run_id` rides along because it
// is what the operator reads on disk (§1) — every call keys on CAP_1.
const CAP_1 = '0192f0aa-1111-7000-8000-000000000001';
const RUN_1 = 'run_20260802_101500';

/** A `Capture` as /record/start, /record/stop and /captures/{id} return it. */
function capture(extra: Record<string, unknown> = {}) {
  return {
    capture_id: CAP_1,
    run_id: RUN_1,
    state: 'recording',
    review_status: 'pending',
    review_revision: 0,
    ...extra,
  };
}

function mockFetch(startExtra: Record<string, unknown> = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/config')) return Promise.resolve(jsonResponse(CONFIG));
    if (url.includes('/record/start'))
      return Promise.resolve(jsonResponse(capture(startExtra)));
    if (url.includes('/record/stop'))
      return Promise.resolve(jsonResponse(capture({ state: 'completed' })));
    return Promise.resolve(jsonResponse({}));
  });
}

// Like mockFetch but with a controllable GET /record/status body — the real
// source of the arming note + integrity banner. Before the operator starts here
// the recorder answers `created` with an EMPTY live set (a fresh recorder has no
// `idle` state, §10), so the test's own start flow is never mistaken for a
// takeover; afterwards it returns `status`.
function mockFetchWithStatus(opts: {
  start?: Record<string, unknown>;
  status?: Record<string, unknown>;
  /** Body for the result-panel `GET /captures/{id}` quick_check poll (F1). */
  detail?: Record<string, unknown>;
  /** Status/body for `PATCH /captures/{id}/review`. */
  review?: { status: number; body: Record<string, unknown> };
}) {
  let started = false;
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.includes('/record/status'))
      return Promise.resolve(
        jsonResponse(
          started
            ? {
                capture_id: CAP_1,
                run_id: RUN_1,
                live_capture_ids: [],
                ...(opts.status ?? {}),
              }
            : {
                capture_id: null,
                run_id: null,
                state: 'created',
                live_capture_ids: [],
              },
        ),
      );
    if (url.includes('/record/start')) {
      started = true;
      return Promise.resolve(jsonResponse(capture(opts.start ?? {})));
    }
    if (url.includes('/record/stop'))
      return Promise.resolve(jsonResponse(capture({ state: 'completed' })));
    if (url.includes('/config')) return Promise.resolve(jsonResponse(CONFIG));
    if (url.includes('/batches') && method === 'POST')
      return Promise.resolve(
        jsonResponse(
          {
            ...(init?.body ? JSON.parse(String(init.body)) : {}),
            batch_id: 'batch_1',
            batch_seq: 1,
            status: 'active',
          },
          201,
        ),
      );
    if (url.includes('/batches')) return Promise.resolve(jsonResponse({ items: [] }));
    if (url.includes('/review') && method === 'PATCH') {
      const r = opts.review;
      if (r) return Promise.resolve(jsonResponse(r.body, r.status));
      return Promise.resolve(
        jsonResponse(capture({ state: 'completed', review_revision: 1 })),
      );
    }
    if (url.includes('/delete') && method === 'POST')
      return Promise.resolve(jsonResponse(capture({ state: 'discarded' })));
    // GET /captures/{id} — the result-panel quick_check poll (F1) and the
    // capture the discard dialog states the size of.
    if (/\/captures\/[^/?]+$/.test(url) && method === 'GET')
      return Promise.resolve(
        jsonResponse(capture({ state: 'completed', ...(opts.detail ?? {}) })),
      );
    if (url.includes('/captures'))
      return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
    return Promise.resolve(jsonResponse({}));
  });
}

async function driveToResult() {
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));
  fireEvent.click(screen.getByRole('button', { name: /Start recording/ }));
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('RECORDING'));
  fireEvent.click(screen.getByRole('button', { name: /Stop recording/ }));
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('Episode 1 result'), {
    timeout: 4000,
  });
}

function phaseTitle() {
  return screen.getByTestId('phase-title');
}

beforeEach(() => {
  setApiBase('/api/v1');
  // These tests are not about the Stop floor; they stop immediately after
  // starting, which the shipped 1s guard would (correctly) refuse.
  __setStopFloorMs(0);
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
  // restoreAllMocks does not touch module state: the stop-floor override set
  // in beforeEach must be reset explicitly or it survives the test.
  __resetStopFloorMs();
});

test('READY phase: shows the Start recording control and context bar', async () => {
  mockFetch();
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
  mockFetch();
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
  // The stop hangs and the recorder keeps reporting the capture as still live,
  // so SAVING persists — proving it waits on the real stop event (D-3), not a
  // fixed timer. Before the start the recorder is `created` with an empty live
  // set (no `idle` on the wire, §10), which keeps this off the takeover path.
  let started = false;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/config')) return Promise.resolve(jsonResponse(CONFIG));
    if (url.includes('/record/start')) {
      started = true;
      return Promise.resolve(jsonResponse(capture()));
    }
    if (url.includes('/record/status'))
      return Promise.resolve(
        jsonResponse(
          started
            ? {
                capture_id: CAP_1,
                run_id: RUN_1,
                state: 'recording',
                live_capture_ids: [CAP_1],
              }
            : {
                capture_id: null,
                run_id: null,
                state: 'created',
                live_capture_ids: [],
              },
        ),
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
  // Honest, non-fabricated copy (no fake MB/percent): while the stop waits on
  // the recorder's flush, the card shows the real elapsed seconds.
  expect(
    screen.getByText(/Finalizing the recording — the recorder is flushing \(\d+ s\)…/),
  ).toBeInTheDocument();
});

// Persona finding P1/P4: a failed TASK must not read as "not usable" data, and
// the operator must see the task outcome in plain language before saving. Quality
// is now the real quick-check (integrity 'ok' → Good), not a fabricated warning.
test('a failed task on a clean recording stays good quality; the single Save action reflects the outcome', async () => {
  mockFetchWithStatus({
    status: { state: 'completed', integrity: 'ok' },
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
  expect(screen.getByTestId('episode-summary')).toHaveTextContent(
    'Task outcome: Failed — Object dropped.',
  );

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
  mockFetchWithStatus({ status: { state: 'completed', integrity: 'ok' } });
  renderWithClient(<CollectScreen />);
  await driveToResult();

  expect(screen.getByText('QUICK: GOOD')).toBeInTheDocument();
  expect(screen.getByText(/Good/)).toBeInTheDocument();
  expect(screen.getByText('· auto')).toBeInTheDocument();

  // Expand the override chips and choose Not usable.
  fireEvent.click(screen.getByRole('button', { name: 'Change' }));
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
    status: { state: 'completed', integrity: 'dropped', dropped_messages: 1234 },
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
    status: { state: 'failed', integrity: 'failed' },
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
    status: { state: 'completed', integrity: 'ok' },
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
    status: { state: 'completed', integrity: 'ok' },
    detail: {
      quick_check: {
        verdict: {
          quality: 'needs_review',
          reasons: [
            '/hsrb/hand_camera/image_raw/compressed avg 9.982Hz < expected 30Hz',
          ],
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
    status: { state: 'completed', integrity: 'ok' },
    // detail omitted -> GET /captures/{id} returns no quick_check (unsettled).
  });
  renderWithClient(<CollectScreen />);
  await driveToResult();

  expect(await screen.findByTestId('quickcheck-pending')).toHaveTextContent(
    'Quick check running…',
  );
  // Saving is never gated on settlement — the primary Save is enabled.
  expect(screen.getByRole('button', { name: /Save — success/ })).toBeEnabled();
});

// ---------------------------------------------------------------------------
// Review save (§4.1) and its two refusals (§12).
// ---------------------------------------------------------------------------

test('Save PATCHes the capture review with base_revision and the batch stamp', async () => {
  const fetchSpy = mockFetchWithStatus({
    status: { state: 'completed', integrity: 'ok' },
  });
  renderWithClient(<CollectScreen />);
  await driveToResult();

  fireEvent.click(screen.getByTestId('save-episode'));
  await waitFor(() =>
    expect(screen.getByTestId('stat-recorded')).toHaveTextContent('1'),
  );

  const patch = fetchSpy.mock.calls.find(
    ([u, i]) =>
      String(u).includes(`/captures/${CAP_1}/review`) && i?.method === 'PATCH',
  );
  expect(patch).toBeTruthy();
  const body = JSON.parse(String((patch![1] as RequestInit).body));
  // A freshly recorded capture has never been reviewed, so the compare-and-swap
  // token is 0. No override was made, so quality/quality_source are OMITTED and
  // the server derives them from its own settled verdict.
  expect(body.base_revision).toBe(0);
  expect(body.task_result).toBe('success');
  // A successful take of good data is adopted BY this save: Datasets refuses
  // anything not adopted, and Review's READY lane has no exception to resolve,
  // so leaving it pending is what stranded every good recording outside the
  // training sets. The quality is still the server's to derive — adoption is
  // the operator's decision, not a claim about the data.
  expect(body.review_status).toBe('adopted');
  expect(body.index_in_batch).toBe(1);
  expect('quality' in body).toBe(false);
  expect('quality_source' in body).toBe(false);
});

test('an operator quality override rides along with operator provenance', async () => {
  const fetchSpy = mockFetchWithStatus({
    status: { state: 'completed', integrity: 'ok' },
  });
  renderWithClient(<CollectScreen />);
  await driveToResult();

  fireEvent.click(screen.getByRole('button', { name: 'Change' }));
  fireEvent.click(screen.getByRole('button', { name: 'Not usable' }));
  fireEvent.click(screen.getByTestId('save-episode'));
  await waitFor(() =>
    expect(screen.getByTestId('stat-recorded')).toHaveTextContent('1'),
  );

  const patch = fetchSpy.mock.calls.find(
    ([u, i]) => String(u).includes('/review') && i?.method === 'PATCH',
  );
  const body = JSON.parse(String((patch![1] as RequestInit).body));
  expect(body.quality).toBe('not_usable');
  expect(body.quality_source).toBe('operator');
  // "Not usable" is the same statement Review's own exclude makes, so the take
  // is not left sitting in the queue it was just taken out of.
  expect(body.review_status).toBe('excluded');
});

test('a 409 review_conflict is surfaced and the episode is NOT counted', async () => {
  mockFetchWithStatus({
    status: { state: 'completed', integrity: 'ok' },
    review: {
      status: 409,
      body: {
        error: {
          code: 'review_conflict',
          message: 'This review was edited elsewhere (revision 2, you sent 0).',
          details: { current_revision: 2 },
        },
      },
    },
  });
  renderWithClient(<CollectScreen />);
  await driveToResult();

  fireEvent.click(screen.getByTestId('save-episode'));

  const banner = await screen.findByTestId('save-error');
  expect(banner).toHaveAttribute('data-error-code', 'review_conflict');
  expect(banner).toHaveTextContent(/edited elsewhere/);
  expect(banner).toHaveTextContent(/apply your change again/);
  // The screen stays on the result panel and claims nothing: no chip, no count.
  expect(phaseTitle()).toHaveTextContent('Episode 1 result');
  expect(screen.getByTestId('stat-recorded')).toHaveTextContent('0');
});

test('a 500 review_sidecar_write_failed says NOTHING was saved, loudly', async () => {
  mockFetchWithStatus({
    status: { state: 'completed', integrity: 'ok' },
    review: {
      status: 500,
      body: {
        error: {
          code: 'review_sidecar_write_failed',
          message: 'Could not write record.json: No space left on device.',
          details: {},
        },
      },
    },
  });
  renderWithClient(<CollectScreen />);
  await driveToResult();

  fireEvent.click(screen.getByTestId('save-episode'));

  const banner = await screen.findByTestId('save-error');
  expect(banner).toHaveAttribute('data-error-code', 'review_sidecar_write_failed');
  // The destructive framing is the point (§12): a quiet note here reads as a
  // successful save to an operator who is already reaching for the next take.
  expect(banner).toHaveTextContent('Not saved');
  expect(banner).toHaveTextContent(/NOTHING was saved/);
  expect(screen.getByTestId('stat-recorded')).toHaveTextContent('0');
  // It stays until the operator dismisses it — never on a timer.
  fireEvent.click(screen.getByTestId('save-error-dismiss'));
  await waitFor(() => expect(screen.queryByTestId('save-error')).toBeNull());
});

test('recording phase shows the real arming matched/missing note from /record/status', async () => {
  mockFetchWithStatus({
    status: {
      state: 'recording',
      live_capture_ids: [CAP_1],
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
  mockFetch();
  renderWithClient(<CollectScreen />);
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));

  const chip = screen.getByTestId('rec-topics-chip');
  expect(chip).toHaveTextContent('REC all topics');
  fireEvent.click(chip);
  await waitFor(() => expect(useUiStore.getState().activeTab).toBe('monitor'));
});

// Discard (§7): the result-phase "Discard & re-record" is ONE CLICK (user
// decision 2026-08-03) — no dialog, no typed reason. The press POSTs
// /captures/{capture_id}/delete with kind 'discard' and the ledger-honest
// automatic reason, then the batch re-arms for a fresh take.
test('Discard & re-record discards in one click, keyed on capture_id', async () => {
  const fetchSpy = mockFetchWithStatus({
    status: { state: 'completed', integrity: 'ok' },
    detail: { bytes: 1048576 },
  });
  renderWithClient(<CollectScreen />);
  await driveToResult();

  fireEvent.click(screen.getByTestId('discard-episode'));
  // Nothing opens — the press is the consent.
  expect(screen.queryByTestId('discard-dialog')).toBeNull();

  await waitFor(() => {
    const del = fetchSpy.mock.calls.find(
      ([u, i]) =>
        String(u).includes(`/captures/${CAP_1}/delete`) && i?.method === 'POST',
    );
    expect(del).toBeTruthy();
    expect(JSON.parse(String((del![1] as RequestInit).body))).toEqual({
      kind: 'discard',
      reason: 'Collect one-click discard (no reason asked)',
    });
  });
  // After a successful discard the batch re-arms for a fresh take.
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));
});

// §12: on a split deployment the discard removes only the copy on this machine.
// With no dialog left to carry that disclosure, the success toast says so
// unprompted — letting an operator believe the robot's copy went too is
// exactly the failure this line exists to prevent. ("May remain", not "is
// untouched": the same wording also serves the probe-unanswered case, where
// the may-remain flag fails toward disclosing — S3-7.)
test('on a split deployment the discard toast says a robot copy may remain', async () => {
  const base = mockFetchWithStatus({
    status: { state: 'completed', integrity: 'ok' },
  });
  // /transfer/status answers `available` only where the pull channel exists —
  // which is the split-mode signal.
  const inner = base.getMockImplementation()!;
  base.mockImplementation((input, init) => {
    if (String(input).includes('/transfer/status'))
      return Promise.resolve(
        jsonResponse({ available: true, auto_pull_on_save: true }),
      );
    return inner(input, init);
  });
  renderWithClient(<CollectScreen />);
  await driveToResult();

  fireEvent.click(screen.getByTestId('discard-episode'));
  await waitFor(() =>
    expect(screen.getByText(/a copy may remain on the robot/i)).toBeInTheDocument(),
  );
});

test('Robot cell lists real robots and switches via POST /config/select', async () => {
  const OPTIONS = {
    active_robot: 'airoa_hsr',
    robots: [
      { id: 'airoa_hsr', local: false },
      { id: 'myrobot', local: false },
    ],
    aspects: {},
  };
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/config/options')) return Promise.resolve(jsonResponse(OPTIONS));
    if (url.includes('/config/select'))
      return Promise.resolve(jsonResponse({ ...OPTIONS, active_robot: 'myrobot' }));
    if (url.includes('/config')) return Promise.resolve(jsonResponse(CONFIG));
    return Promise.resolve(jsonResponse({}));
  });
  renderWithClient(<CollectScreen />);

  const cell = () =>
    screen.getByTitle('Switch robot config (disabled while recording)');
  await waitFor(() => expect(cell()).toHaveTextContent('airoa_hsr'));

  fireEvent.click(cell());
  fireEvent.click(await screen.findByRole('button', { name: /myrobot/ }));

  await waitFor(() => {
    const call = fetchSpy.mock.calls.find((c) =>
      String(c[0]).includes('/config/select'),
    );
    expect(call).toBeTruthy();
    expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({
      category: 'robot',
      id: 'myrobot',
    });
  });
  // The cell reflects the response's new active robot (cache updated in place).
  await waitFor(() => expect(cell()).toHaveTextContent('myrobot'));
});

// ---------------------------------------------------------------------------
// Shared plans store: a Settings edit must reflect in Collect's pickers, and a
// removed selection must degrade gracefully (no crash).
// ---------------------------------------------------------------------------

test('a project added to the shared store appears in the Collect project picker', async () => {
  mockFetch();
  // Simulate a Settings edit: add a project to the shared catalog.
  setPlans([
    ...clonePlans(getPlans()),
    {
      project_id: 'project-warehouse-sort',
      name: 'Warehouse Sort',
      tasks: [
        {
          task_id: 'task-sort',
          name: 'Sort',
          conditions: [{ condition_id: 'condition-bin-a', name: 'Bin: A' }],
        },
      ],
    },
  ]);
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
  const fetchSpy = mockFetch();
  vi.spyOn(window, 'prompt').mockReturnValue('Fold the towel');
  renderWithClient(<CollectScreen />);
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));

  fireEvent.click(screen.getByTitle('Change task (from plan)'));
  fireEvent.click(screen.getByRole('button', { name: /Custom/ }));

  // Shown as the selected task, and NOT added to the plans catalog.
  await waitFor(() => expect(screen.getByText('Fold the towel')).toBeInTheDocument());
  expect(getPlans().some((p) => p.tasks.some((t) => t.name === 'Fold the towel'))).toBe(
    false,
  );

  fireEvent.click(screen.getByRole('button', { name: /Start recording/ }));
  await waitFor(() => {
    const start = fetchSpy.mock.calls.find((c) =>
      String(c[0]).includes('/record/start'),
    );
    expect(start).toBeTruthy();
    expect(JSON.parse(String((start![1] as RequestInit).body)).task).toBe(
      'Fold the towel',
    );
  });
});

test('Collect degrades gracefully when its selected project is absent from the store', async () => {
  mockFetch();
  // The machine seeded its project from the default catalog; now replace the
  // catalog so that selection no longer exists (as if it were removed/renamed).
  setPlans([
    {
      project_id: 'project-only',
      name: 'Only Project',
      tasks: [
        {
          task_id: 'task-only',
          name: 'Only Task',
          conditions: [{ condition_id: 'condition-only', name: 'Only Cond' }],
        },
      ],
    },
  ]);
  renderWithClient(<CollectScreen />);

  // Still renders (no crash); the orphaned selection stays shown as-is, and the
  // task picker falls back to the surviving project's tasks.
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));
  expect(screen.getByText('Tabletop Manipulation')).toBeInTheDocument();
  fireEvent.click(screen.getByTitle('Change task (from plan)'));
  expect(screen.getByRole('button', { name: 'Only Task' })).toBeInTheDocument();
});

test('a fallback task relabels an empty active batch with matching labels and IDs after reload', async () => {
  const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> =
    [];
  let remote = {
    batch_id: 'batch-stale',
    batch_seq: 4,
    status: 'active',
    operator: 'tester',
    project: 'Removed project',
    project_id: 'project-removed',
    task: 'Removed task',
    task_id: 'task-removed',
    condition: 'Removed condition',
    condition_id: 'condition-removed',
    target_episodes: 30,
    captures: [],
  };
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    calls.push({ url, method, body });
    if (url.includes('/config')) return Promise.resolve(jsonResponse(CONFIG));
    if (url.includes('/batches/batch-stale') && method === 'GET') {
      return Promise.resolve(jsonResponse(remote));
    }
    if (url.includes('/batches/batch-stale') && method === 'PATCH') {
      remote = { ...remote, ...body };
      return Promise.resolve(jsonResponse(remote));
    }
    if (url.includes('/record/start')) return Promise.resolve(jsonResponse(capture()));
    if (url.includes('/record/status')) {
      return Promise.resolve(
        jsonResponse({
          capture_id: null,
          run_id: null,
          state: 'created',
          live_capture_ids: [],
        }),
      );
    }
    if (url.includes('/batches')) return Promise.resolve(jsonResponse({ items: [] }));
    return Promise.resolve(jsonResponse({}));
  });

  window.localStorage.setItem(
    'kairos.collect.batch',
    JSON.stringify({
      batchSeq: 4,
      recordedCount: 0,
      targetEpisodes: 30,
      batchId: 'batch-stale',
      episodes: [],
      project: 'Removed project',
      projectId: 'project-removed',
      task: 'Removed task',
      taskId: 'task-removed',
      condition: 'Removed condition',
      lastCaptureId: null,
    }),
  );
  __rehydrateBatchStore();
  setPlans([
    {
      project_id: 'project-surviving',
      name: 'Surviving project',
      tasks: [
        {
          task_id: 'task-surviving',
          name: 'Surviving task',
          conditions: [
            { condition_id: 'condition-surviving', name: 'Surviving condition' },
          ],
        },
      ],
    },
  ]);

  const first = renderWithClient(<CollectScreen />);
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));
  fireEvent.click(screen.getByTitle('Change task (from plan)'));
  fireEvent.click(screen.getByRole('button', { name: 'Surviving task' }));

  await waitFor(() =>
    expect(
      calls.find(
        (call) => call.url.includes('/batches/batch-stale') && call.method === 'PATCH',
      )?.body,
    ).toMatchObject({
      project: 'Surviving project',
      project_id: 'project-surviving',
      task: 'Surviving task',
      task_id: 'task-surviving',
      condition: 'Surviving condition',
      condition_id: 'condition-surviving',
    }),
  );

  first.unmount();
  __rehydrateBatchStore();
  renderWithClient(<CollectScreen />);
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));
  fireEvent.click(screen.getByRole('button', { name: /Start recording/ }));

  await waitFor(() =>
    expect(calls.some((call) => call.url.includes('/record/start'))).toBe(true),
  );
  expect(
    calls.find((call) => call.url.includes('/record/start'))?.body?.collection_context,
  ).toMatchObject({
    batch_id: 'batch-stale',
    project: 'Surviving project',
    project_id: 'project-surviving',
    task: 'Surviving task',
    task_id: 'task-surviving',
    condition: 'Surviving condition',
    condition_id: 'condition-surviving',
  });
});

test('a stale same-name project/task shows no catalog conditions but keeps custom input', async () => {
  mockFetch();
  renderWithClient(<CollectScreen />);
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));
  await act(async () => {
    setPlans([
      {
        project_id: 'project-replaced',
        name: 'Tabletop Manipulation',
        tasks: [
          {
            task_id: 'task-replaced',
            name: 'Pick and Place',
            conditions: [
              { condition_id: 'condition-replaced', name: 'Replacement condition' },
            ],
          },
        ],
      },
    ]);
  });

  fireEvent.click(
    screen.getByTitle(
      'Change condition (starts a new set once this one has recordings)',
    ),
  );
  expect(
    screen.getByText(/project or task is no longer in the catalog/i),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'Replacement condition' }),
  ).not.toBeInTheDocument();
  const custom = screen.getByTestId('custom-condition-input');
  fireEvent.change(custom, { target: { value: 'Manual recovery condition' } });
  fireEvent.click(screen.getByTestId('custom-condition-add'));
  await waitFor(() =>
    expect(screen.getByText('Manual recovery condition')).toBeInTheDocument(),
  );
});

test('Batch menu → Reset batch on an empty batch is a no-op (honest wording)', async () => {
  mockFetch();
  renderWithClient(<CollectScreen />);
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));
  // No recording yet → no server set → the Set cell shows an honest, muted
  // prediction of the next number instead of a bare "—".
  expect(screen.getByText(/assigned on first recording/)).toBeInTheDocument();
  expect(screen.queryByText('Batch —')).toBeNull();

  fireEvent.click(screen.getByText('Batch menu'));
  fireEvent.click(screen.getByText('Reset batch…'));

  // Empty set → no-number title + no-op wording (nothing created or closed).
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

const CAP_EXT = '0192f0aa-2222-7000-8000-00000000ffff';

test('a server recording surfaces Take control instead of READY or ordinary Stop', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/config')) return Promise.resolve(jsonResponse(CONFIG));
    if (url.includes(`/captures/${CAP_EXT}`))
      return Promise.resolve(
        jsonResponse({
          capture_id: CAP_EXT,
          run_id: 'run_20260802_090000',
          state: 'recording',
          review_status: 'pending',
          review_revision: 0,
          topics: [{ name: '/a', type: 'x' }],
          operator: 'other',
        }),
      );
    if (url.includes('/captures'))
      return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
    if (url.includes('/record/status'))
      // `live_capture_ids` names WHICH capture is live; the singular capture_id
      // would still point here long after a stop (§10), so it is not the key.
      return Promise.resolve(
        jsonResponse({
          capture_id: CAP_EXT,
          run_id: 'run_20260802_090000',
          state: 'recording',
          live_capture_ids: [CAP_EXT],
          started_at: new Date().toISOString(),
          bytes: 4096,
        }),
      );
    return Promise.resolve(jsonResponse({}));
  });
  renderWithClient(<CollectScreen />);

  await waitFor(() => expect(phaseTitle()).toHaveTextContent('RECORDING IN PROGRESS'));
  expect(screen.getByText(/wasn't started from this screen/)).toBeInTheDocument();
  // The run_id is shown as the recording's human-readable name (§1).
  await waitFor(() =>
    expect(screen.getByText('run_20260802_090000')).toBeInTheDocument(),
  );
  // The foreign recording offers explicit recovery, never the ordinary Stop.
  expect(screen.queryByRole('button', { name: /Stop recording/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Take control' }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText('Recording control')).toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: 'Take control' })).toBeEnabled();
});

// §10 rev.2.4: a status with NO `live_capture_ids` means the recorder could not
// be reached. Treating that as "nothing is live" would hand the operator a READY
// button while a recording may well be running; treating it as a takeover would
// invent one. Neither: the screen claims no takeover and the Recorder row says
// it has no answer.
test('a status missing live_capture_ids claims no takeover and reports no answer', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/config')) return Promise.resolve(jsonResponse(CONFIG));
    if (url.includes('/captures'))
      return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
    if (url.includes('/record/status'))
      return Promise.resolve(
        jsonResponse({ capture_id: CAP_EXT, run_id: 'run_x', state: 'recording' }),
      );
    return Promise.resolve(jsonResponse({}));
  });
  renderWithClient(<CollectScreen />);

  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));
  expect(screen.queryByText('RECORDING IN PROGRESS')).toBeNull();
  await waitFor(() =>
    expect(screen.getByTestId('sys-recorder')).toHaveTextContent('no answer'),
  );
  // …and the warnings card no longer answers "no active warnings" over it (#13):
  // the Recorder row is CHECK, so it is restated there with what to do about it.
  const checks = await screen.findByTestId('collect-check-recorder');
  expect(checks).toHaveTextContent(/not answering/i);
  expect(screen.queryByText('No active warnings')).toBeNull();
});

// ---------------------------------------------------------------------------
// D-3 unsaved-take recovery banner.
// ---------------------------------------------------------------------------

test('an unsaved completed take shows the recovery banner with Label / Discard / Later', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/config')) return Promise.resolve(jsonResponse(CONFIG));
    if (url.includes('/captures'))
      // `review_revision: 0` is the server's own "never reviewed" (§4.1) — the
      // browser-local mirror that used to answer this question is gone.
      return Promise.resolve(
        jsonResponse({
          items: [
            {
              capture_id: '0192f0aa-3333-7000-8000-0000000000aa',
              run_id: 'run_20260802_080000',
              state: 'completed',
              review_status: 'pending',
              review_revision: 0,
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
  mockFetchWithStatus({ status: { state: 'completed', integrity: 'ok' } });
  renderWithClient(<CollectScreen />);
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: /Start recording/ }),
    ),
  );

  await driveToResult();
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: /Save — success/ }),
    ),
  );
});

test('keyboard shortcuts: R starts and S stops, but typing in an input is ignored', async () => {
  mockFetch();
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
  mockFetch();
  renderWithClient(<CollectScreen />);
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));
  fireEvent.keyDown(document.body, { key: '?' });
  expect(await screen.findByText('Keyboard shortcuts')).toBeInTheDocument();
});

// ---- QA regressions -------------------------------------------------------

// B1: the recorder dies mid-recording. react-query keeps serving the last
// successful /record/status, so every surface reading `.data` alone kept
// insisting a recording was in progress. A failed poll must retract the claim.
test('a recorder that stops answering stops being reported as recording', async () => {
  let recorderAlive = true;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/record/status')) {
      if (!recorderAlive) return Promise.reject(new Error('recorder unreachable'));
      return Promise.resolve(
        jsonResponse({
          capture_id: CAP_1,
          run_id: RUN_1,
          state: 'recording',
          live_capture_ids: [CAP_1],
          started_at: '2026-08-01T00:00:00.000Z',
        }),
      );
    }
    if (url.includes('/config')) return Promise.resolve(jsonResponse(CONFIG));
    if (url.includes('/batches')) return Promise.resolve(jsonResponse({ items: [] }));
    if (url.includes('/captures'))
      return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
    return Promise.resolve(jsonResponse({}));
  });

  renderWithClient(<CollectScreen />);
  // A recording this screen did not start reads as a takeover while the
  // recorder is answering for it.
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('RECORDING IN PROGRESS'));

  recorderAlive = false;
  // Once the poll fails the screen stops asserting a recording is running: it
  // no longer has any evidence that one is.
  await waitFor(
    () => expect(phaseTitle()).not.toHaveTextContent('RECORDING IN PROGRESS'),
    { timeout: 8000 },
  );
}, 15000);

// B1 (qa-ui shots/14b): docker-stop the recorder mid-recording and Collect kept
// showing "RECORDING" with the elapsed timer CLIMBING (00:12 → 00:37) and
// SYSTEM STATUS "Recorder: recording/REC", while every /record/status returned
// 503. An animating timer is an active claim that a recording is progressing;
// once the poll fails we have no evidence of that.
test('a recorder that dies mid-recording flips the card to unreachable and freezes the timer', async () => {
  __setStopFloorMs(0);
  let recorderAlive = true;
  let started = false;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/record/status')) {
      if (!recorderAlive) {
        return Promise.resolve(
          jsonResponse(
            {
              error: {
                code: 'recorder_unreachable',
                message: 'the recorder is unreachable',
              },
            },
            503,
          ),
        );
      }
      // Idle until THIS screen starts, so its own start is never mistaken for
      // a takeover.
      return Promise.resolve(
        jsonResponse(
          started
            ? {
                capture_id: CAP_1,
                run_id: RUN_1,
                state: 'recording',
                live_capture_ids: [CAP_1],
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
      return Promise.resolve(jsonResponse(capture({})));
    }
    if (url.includes('/config')) return Promise.resolve(jsonResponse(CONFIG));
    if (url.includes('/batches')) return Promise.resolve(jsonResponse({ items: [] }));
    if (url.includes('/captures'))
      return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
    return Promise.resolve(jsonResponse({}));
  });

  renderWithClient(<CollectScreen />);
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));
  fireEvent.click(screen.getByRole('button', { name: /Start recording/ }));
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('RECORDING'));

  recorderAlive = false;

  // The card stops asserting a recording is in progress …
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('Recorder unreachable'), {
    timeout: 10000,
  });
  // … and says what it actually knows, and how old that is.
  const note = screen.getByTestId('recorder-unreachable-note');
  expect(note).toHaveTextContent('Last known:');
  expect(note.textContent).toMatch(/\d+s ago/);
  expect(note.textContent).toMatch(/not current/);

  // The elapsed clock is frozen: whatever it reads now, it still reads later.
  const frozen = screen.getByTestId('elapsed').textContent;
  await new Promise((r) => setTimeout(r, 700));
  expect(screen.getByTestId('elapsed').textContent).toBe(frozen);

  // And SYSTEM STATUS stops reporting the recorder as fine.
  await waitFor(() =>
    expect(screen.getByTestId('sys-recorder')).toHaveTextContent('no answer'),
  );
}, 20000);

// E-1: the two B1 behaviours above compose into a trap. The elapsed figure is
// frozen (correctly — it is a claim we can no longer support), and the Stop
// floor was measured against that same frozen figure. A recorder that dies
// inside the first second therefore left `elapsedMs` below the floor for good:
// Stop disabled for the rest of the take, and the S / Space path guarded by the
// same flag, so the operator had NO way to end it.
//
// The floor exists to defeat a double-click, which is a fact about how long the
// take has existed — not about whether we can still see the recorder. An
// operator must always be able to end a take; a stop against a recorder that is
// not there fails loudly, which is honest, whereas forbidding it pre-emptively
// is not.
// A recorder that dies the instant its take begins. The start's own status
// invalidation is the poll that fails, so the freeze lands INSIDE the stop floor
// with the elapsed figure still at zero — the state the trap needs.
function mockRecorderDyingAtStart(): { stopAttempts: () => number } {
  let recorderAlive = true;
  let started = false;
  let attempts = 0;
  const unreachableBody = {
    error: { code: 'recorder_unreachable', message: 'the recorder is unreachable' },
  };
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/record/status')) {
      if (!recorderAlive) return Promise.resolve(jsonResponse(unreachableBody, 503));
      return Promise.resolve(
        jsonResponse(
          started
            ? {
                capture_id: CAP_1,
                run_id: RUN_1,
                state: 'recording',
                live_capture_ids: [CAP_1],
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
      recorderAlive = false;
      return Promise.resolve(jsonResponse(capture({})));
    }
    if (url.includes('/record/stop')) {
      attempts += 1;
      return Promise.resolve(jsonResponse(unreachableBody, 503));
    }
    if (url.includes('/config')) return Promise.resolve(jsonResponse(CONFIG));
    if (url.includes('/batches')) return Promise.resolve(jsonResponse({ items: [] }));
    if (url.includes('/captures'))
      return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
    return Promise.resolve(jsonResponse({}));
  });
  return { stopAttempts: () => attempts };
}

/** Start a take, lose the recorder inside the floor, and return the Stop button
 *  once the wall clock has cleared the floor. Asserts the trap's preconditions
 *  on the way through. */
async function reachUnreachableRecordingPastFloor(): Promise<HTMLElement> {
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('READY'));
  fireEvent.click(screen.getByRole('button', { name: /Start recording/ }));
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('Recorder unreachable'), {
    timeout: 10000,
  });
  // The card says it cannot see the recorder, and the elapsed figure is frozen
  // at zero — under the floor, where it now stays.
  expect(screen.getByTestId('recorder-unreachable-note')).toBeInTheDocument();
  expect(screen.getByTestId('elapsed')).toHaveTextContent('00:00:00');

  const stop = screen.getByTestId('stop-recording');
  await waitFor(() => expect(stop).toBeEnabled(), { timeout: 4000 });
  // The note is still up: nothing here claims the recorder came back.
  expect(screen.getByTestId('recorder-unreachable-note')).toBeInTheDocument();
  return stop;
}

test('a recorder that dies inside the stop floor still lets the operator end the take', async () => {
  // The floor a real operator gets — this test is about the guard as shipped.
  __resetStopFloorMs();
  const recorder = mockRecorderDyingAtStart();

  renderWithClient(<CollectScreen />);
  const stop = await reachUnreachableRecordingPastFloor();

  // Pressing it really ends the take: the stop is attempted and its failure is
  // shown, rather than being pre-empted by a control that refuses to be used.
  fireEvent.click(stop);
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('SAVING'));
  expect(recorder.stopAttempts()).toBeGreaterThan(0);
  await waitFor(() =>
    expect(screen.getByText(/Can.t reach the recorder/)).toBeInTheDocument(),
  );
}, 20000);

// The keyboard paths are guarded by the same `canStop` the button reads, so
// they came back with it — but "so it does" is exactly the claim a refactor
// that splits them would falsify quietly. Space is the one an operator hits
// without looking, and it is the last way out of a take nobody can end.
test('Space ends the take too when the recorder died inside the stop floor', async () => {
  __resetStopFloorMs();
  const recorder = mockRecorderDyingAtStart();

  renderWithClient(<CollectScreen />);
  await reachUnreachableRecordingPastFloor();

  fireEvent.keyDown(document.body, { key: ' ' });
  await waitFor(() => expect(phaseTitle()).toHaveTextContent('SAVING'));
  expect(recorder.stopAttempts()).toBeGreaterThan(0);
}, 20000);

// #14 — heading structure. This screen must title itself exactly once and
// descend one heading level at a time, so a screen-reader user can navigate it
// by heading instead of reading it as one flat run of text.
test('titles itself with a single h1 and skips no heading level', async () => {
  renderWithClient(<CollectScreen />);
  // Let the screen's cards land first — the h1 appears before them, and a
  // spine snapshotted at that instant would pin almost nothing.
  await screen.findByTestId('sys-recorder');
  await expectScreenHeadingOutline('Collect');
  // The exact h1/h2 spine. The outline check above cannot see a heading that is
  // MISSING — it walks what IS rendered — so demoting any promoted title back to
  // a span would leave it green. This is what pins the promotions.
  expectHeadingSpine([
    'h1 Collect',
    // The control card's phase title — it changes with the phase, and it is the
    // screen's primary card, so it belongs on the spine.
    'h2 READY',
    'h2 System status',
    'h2 Active warnings',
    'h2 General tip · static guidance',
    'h2 Batch stats',
    'h2 Coverage — Pick and Place',
  ]);
}, 20000);
