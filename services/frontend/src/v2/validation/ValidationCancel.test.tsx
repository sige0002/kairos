// The two halves of the endurance finding "validation jobs keep going, unseen
// and unstoppable":
//
//  1. Cancel — a queued/running job can be stopped from the screen that started
//     it, one job at a time or the whole run, and the result is reported as
//     CANCELED rather than as a failure.
//  2. Survival — the run lives in a module store, so leaving the tab (which
//     unmounts the screen) no longer erases a run that is still going.
//
// The fetch mock keeps a per-job state map so a cancel actually changes what
// the status endpoint answers, rather than the test asserting against a reply
// it hard-coded.

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { renderWithClient, jsonResponse } from '../../test/renderWithClient';
import { ValidationScreen } from './ValidationScreen';
import { __resetValidationRun } from './runStore';

const PIPELINES = {
  items: [
    { id: 'fast_validation', name: 'Fast validation', enabled: true },
    { id: 'loss_report', name: 'Loss report', enabled: true },
  ],
};

const REPLICA_HERE = { instance_id: 'inst_local', state: 'present_verified' };

const CAPTURES = {
  items: [
    {
      capture_id: 'cap_002',
      run_id: 'run_002',
      state: 'completed',
      review_status: 'pending',
      review_revision: 0,
      replica: REPLICA_HERE,
      digest_state: 'complete',
      batch_id: 'batch_x',
    },
    {
      capture_id: 'cap_001',
      run_id: 'run_001',
      state: 'completed',
      review_status: 'pending',
      review_revision: 0,
      replica: REPLICA_HERE,
      digest_state: 'complete',
      batch_id: 'batch_x',
    },
  ],
};

const OPTIONS = {
  active_robot: 'airoa_hsr',
  robots: [{ id: 'airoa_hsr', local: false }],
  aspects: {
    recording: { active: 'default', options: [] },
    stream: { active: 'default', options: [] },
    validation: { active: 'airoa_hsr', options: [] },
    validators: { active: 'loss_report', options: [] },
  },
};

const RUNTIME_CONFIG = {
  endpoints: { api: '/api/v1', events: '/api/v1/events', webrtc: '/webrtc' },
  tabs: [],
  defaults: {},
  schemas: { pipeline_forms: { loss_report: { type: 'object', properties: {} } } },
};

const PRESETS = {
  items: [
    {
      id: 'loss_sweep',
      name: 'Loss sweep',
      description: 'Loss report over everything pending.',
      pipeline: 'loss_report',
      params: {},
      total: 2,
      pending: 2,
      pending_capture_ids: ['cap_002', 'cap_001'],
    },
  ],
};

const BATCHES = {
  items: [
    {
      batch_id: 'batch_x',
      project: 'proj',
      task: 'pick',
      condition: 'cond_a',
      target_episodes: 30,
      status: 'active',
      created_at: '2026-07-13T09:00:00Z',
      episodes_recorded: 2,
      episode_count: 2,
      batch_seq: 4,
    },
  ],
};

/** job_id -> its current server-side state. A cancel mutates this, so the
 *  status endpoint tells the truth afterwards. */
let jobState: Record<string, string> = {};
let jobCapture: Record<string, string> = {};
let cancelCalls: string[] = [];
/** Job ids whose cancel the server refuses (the error path). */
let refuseCancelFor: Set<string>;
let jobCounter = 0;

function statusBody(jobId: string) {
  return {
    job_id: jobId,
    capture_id: jobCapture[jobId] ?? 'cap_002',
    pipeline: 'loss_report',
    state: jobState[jobId] ?? 'running',
    progress: jobState[jobId] === 'running' ? 0.4 : 1,
  };
}

beforeEach(() => {
  setApiBase('/api/v1');
  __resetValidationRun();
  jobState = {};
  jobCapture = {};
  cancelCalls = [];
  refuseCancelFor = new Set();
  jobCounter = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (url.includes('/validation/presets')) return Promise.resolve(jsonResponse(PRESETS));
    if (url.includes('/batches')) return Promise.resolve(jsonResponse(BATCHES));
    if (url.includes('/config/options')) return Promise.resolve(jsonResponse(OPTIONS));
    if (url.endsWith('/api/v1/config') || url.endsWith('/api/v1/config/')) {
      return Promise.resolve(jsonResponse(RUNTIME_CONFIG));
    }
    if (url.includes('/pipelines')) return Promise.resolve(jsonResponse(PIPELINES));

    const cancelMatch = url.match(/\/jobs\/([^/]+)\/cancel/);
    if (cancelMatch) {
      const id = cancelMatch[1]!;
      cancelCalls.push(id);
      if (refuseCancelFor.has(id)) {
        return Promise.resolve(
          jsonResponse(
            { error: { code: 'job_not_cancellable', message: 'the runner is not answering' } },
            409,
          ),
        );
      }
      jobState[id] = 'canceled';
      return Promise.resolve(jsonResponse(statusBody(id)));
    }
    const statusMatch = url.match(/\/jobs\/([^/]+)\/status/);
    if (statusMatch) return Promise.resolve(jsonResponse(statusBody(statusMatch[1]!)));
    // A canceled job has no result; the server refuses it the way it refuses
    // any job that produced none.
    if (url.match(/\/jobs\/[^/]+\/result/)) {
      return Promise.resolve(
        jsonResponse({ error: { code: 'job_no_result', message: 'no result' } }, 404),
      );
    }
    if (url.endsWith('/jobs')) {
      const body = JSON.parse(String((init as RequestInit).body)) as {
        capture_id: string;
        pipeline: string;
      };
      jobCounter += 1;
      const jobId = `j${jobCounter}`;
      jobState[jobId] = 'running';
      jobCapture[jobId] = body.capture_id;
      return Promise.resolve(jsonResponse(statusBody(jobId)));
    }
    if (url.match(/\/captures\/[^/?]+$/)) {
      const id = url.split('/captures/')[1] ?? '';
      return Promise.resolve(jsonResponse({ capture_id: id, topics: [] }));
    }
    if (url.includes('/captures')) return Promise.resolve(jsonResponse(CAPTURES));
    return Promise.resolve(jsonResponse({}));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetValidationRun();
});

/** Select loss_report (no required params) and start a run on one capture. */
async function startSingleRun() {
  fireEvent.click(await screen.findByTestId('pipeline-card-loss_report'));
  fireEvent.click(await screen.findByRole('button', { name: 'Run on selection' }));
  await screen.findByTestId('running-jobs');
}

// ---- 1. cancel -----------------------------------------------------------

test('a running job can be cancelled from the run it belongs to', async () => {
  renderWithClient(<ValidationScreen />);
  await startSingleRun();

  // The per-job row is there and says what the job is doing.
  expect(await screen.findByTestId('job-state-cap_002')).toHaveTextContent('Running');

  fireEvent.click(screen.getByTestId('cancel-job-cap_002'));

  await waitFor(() => expect(cancelCalls).toEqual(['j1']));
  // The run settles on the cancel, and the screen says CANCELED — not failed,
  // and not the "already validated" line that a result-less job used to get.
  expect(await screen.findByTestId('run-canceled')).toBeInTheDocument();
  expect(screen.queryByText(/every target is already validated/i)).toBeNull();
  expect(screen.queryByText(/FAIL/)).toBeNull();
});

test('Cancel run stops every job of the run that had not finished', async () => {
  renderWithClient(<ValidationScreen />);
  fireEvent.click(await screen.findByTestId('pipeline-card-loss_report'));
  // The preset runs loss_report over both pending captures — a two-job run.
  fireEvent.click(await screen.findByTestId('preset-loss_sweep'));
  await screen.findByTestId('running-jobs');

  fireEvent.click(await screen.findByTestId('cancel-run'));

  await waitFor(() => expect(cancelCalls.sort()).toEqual(['j1', 'j2']));
  // Both cancelled, so both rows are CANCELED and neither is counted as a
  // result in the three tiles.
  expect(await screen.findByTestId('canceled-note')).toHaveTextContent(
    '2 of 2 canceled',
  );
});

test('a job that already finished is not asked to cancel', async () => {
  renderWithClient(<ValidationScreen />);
  fireEvent.click(await screen.findByTestId('pipeline-card-loss_report'));
  fireEvent.click(await screen.findByTestId('preset-loss_sweep'));
  await screen.findByTestId('running-jobs');

  // One of the two finishes on its own before the operator hits Cancel run.
  // Waiting out a real poll (VALIDATION_JOB_POLL_MS), so the timeout has to
  // clear it — this is the screen noticing on its own, not a seeded reply.
  jobState.j1 = 'succeeded';
  await waitFor(
    () => expect(screen.getByTestId('job-state-cap_002')).toHaveTextContent('Done'),
    { timeout: 4000 },
  );
  // A finished job offers no Cancel of its own.
  expect(screen.queryByTestId('cancel-job-cap_002')).toBeNull();

  fireEvent.click(screen.getByTestId('cancel-run'));
  await waitFor(() => expect(cancelCalls).toEqual(['j2']));
});

test('a refused cancel is reported and held, because the job is still running', async () => {
  renderWithClient(<ValidationScreen />);
  await startSingleRun();
  refuseCancelFor.add('j1');

  fireEvent.click(screen.getByTestId('cancel-job-cap_002'));

  const banner = await screen.findByTestId('cancel-error');
  expect(banner).toHaveTextContent(/Cancel failed/);
  expect(banner).toHaveTextContent(/still running/);
  // The job is untouched, so the run is still going and still cancellable.
  expect(screen.getByTestId('job-state-cap_002')).toHaveTextContent('Running');
  expect(screen.getByTestId('cancel-job-cap_002')).toBeInTheDocument();

  fireEvent.click(screen.getByTestId('cancel-error-dismiss'));
  await waitFor(() => expect(screen.queryByTestId('cancel-error')).toBeNull());
});

// ---- 2. the run survives leaving the tab ---------------------------------

/** The shell renders only the active tab, so switching away unmounts the
 *  screen entirely — this is that, and nothing else. */
function Tabbed({ onValidation }: { onValidation: boolean }) {
  return onValidation ? <ValidationScreen /> : <p>another tab</p>;
}

test('a run still going is restored after a tab round-trip', async () => {
  const { rerender } = renderWithClient(<Tabbed onValidation />);
  await startSingleRun();
  expect(await screen.findByTestId('job-state-cap_002')).toHaveTextContent('Running');

  // Leave the tab: the screen is unmounted, exactly as App.tsx does it.
  rerender(<Tabbed onValidation={false} />);
  expect(screen.queryByTestId('running-jobs')).toBeNull();
  await screen.findByText('another tab');

  // Come back.
  rerender(<Tabbed onValidation />);

  // The run is still on screen — the same job, still reported as running, and
  // still stoppable. Before the run moved into a module store this came back
  // idle, with the job going on the server and nothing pointing at it.
  expect(await screen.findByTestId('running-jobs')).toBeInTheDocument();
  expect(screen.getByTestId('job-state-cap_002')).toHaveTextContent('Running');
  expect(screen.getByTestId('cancel-job-cap_002')).toBeInTheDocument();
  // No second submission happened just because we came back.
  expect(jobCounter).toBe(1);
});

test('a run restored after a tab round-trip can still be cancelled', async () => {
  const { rerender } = renderWithClient(<Tabbed onValidation />);
  await startSingleRun();

  rerender(<Tabbed onValidation={false} />);
  rerender(<Tabbed onValidation />);

  fireEvent.click(await screen.findByTestId('cancel-job-cap_002'));
  await waitFor(() => expect(cancelCalls).toEqual(['j1']));
  expect(await screen.findByTestId('run-canceled')).toBeInTheDocument();
});
