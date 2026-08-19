// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { renderWithClient, jsonResponse } from '../../test/renderWithClient';
import { ValidationScreen } from './ValidationScreen';
import { expectScreenHeadingOutline } from '../../test/headingOutline';

const PIPELINES = {
  items: [
    { id: 'fast_validation', name: 'Fast validation', enabled: true },
    { id: 'hello_kairos', name: 'Hello kairos (greeting)', enabled: true },
    { id: 'loss_report', name: 'Loss report', enabled: true },
    { id: 'video_check', name: 'Video check', enabled: true },
  ],
};

const REPLICA_HERE = { instance_id: 'inst_local', state: 'present_verified' };
const REPLICA_UNVERIFIED = { instance_id: 'inst_local', state: 'present_unverified' };

// Newest-first, as GET /captures returns them. capture_id is the API key and
// run_id is the display name (§1) — they differ here so a test that asserts one
// cannot accidentally pass on the other.
const CAPTURES = {
  items: [
    // Newest of all, but no local copy: a split deploy reviewed it before the
    // bytes were pulled. It must not become the default target.
    {
      capture_id: 'cap_003',
      run_id: 'run_003',
      state: 'completed',
      review_status: 'pending',
      review_revision: 0,
      replica: null,
      batch_id: 'batch_x',
    },
    // Not in batch_x: the batch is cap_001 + cap_003, so a batch run over it
    // must not sweep this one in.
    {
      capture_id: 'cap_002',
      run_id: 'run_002',
      state: 'completed',
      review_status: 'pending',
      review_revision: 0,
      replica: REPLICA_HERE,
      digest_state: 'complete',
    },
    {
      capture_id: 'cap_001',
      run_id: 'run_001',
      state: 'completed',
      review_status: 'adopted',
      review_revision: 1,
      replica: REPLICA_UNVERIFIED,
      digest_state: 'pending',
      batch_id: 'batch_x',
    },
    // Still being written: a pipeline would read a bag mid-flight.
    {
      capture_id: 'cap_live',
      run_id: 'run_live',
      state: 'recording',
      review_status: 'pending',
      review_revision: 0,
      replica: REPLICA_UNVERIFIED,
    },
  ],
  next_cursor: null,
};

const CAPTURE_TOPICS = [
  { name: '/hsrb/joint_states', type: 'sensor_msgs/msg/JointState' },
  {
    name: '/hsrb/head_rgbd_sensor/rgb/image_rect_color/compressed',
    type: 'sensor_msgs/msg/CompressedImage',
  },
];

// Per-capture topic inventories: two recordings from DIFFERENT robots, so a
// camera topic chosen for one is not even offered by the other. Anything else
// would let a carried-over parameter look correct by coincidence.
const TOPICS_BY_CAPTURE: Record<string, { name: string; type: string }[]> = {
  cap_002: [
    { name: '/hsrb/joint_states', type: 'sensor_msgs/msg/JointState' },
    {
      name: '/hsrb/head_rgbd_sensor/rgb/image_rect_color/compressed',
      type: 'sensor_msgs/msg/CompressedImage',
    },
    {
      name: '/hsrb/hand_camera/image_raw/compressed',
      type: 'sensor_msgs/msg/CompressedImage',
    },
  ],
  cap_001: [
    { name: '/myrobot/joint_states', type: 'sensor_msgs/msg/JointState' },
    {
      name: '/myrobot/front_camera/image_raw/compressed',
      type: 'sensor_msgs/msg/CompressedImage',
    },
  ],
};

const OPTIONS = {
  active_robot: 'airoa_hsr',
  robots: [{ id: 'airoa_hsr', local: false }],
  aspects: {
    recording: { active: 'default', options: [] },
    stream: { active: 'default', options: [] },
    validation: {
      active: 'airoa_hsr',
      options: [
        {
          id: 'airoa_hsr',
          path: '/config/airoa_hsr/validation/default.yaml',
          local: false,
          meta: {
            name: 'airoa_hsr',
            version: 1,
            required_topics: [
              { name: '/hsrb/joint_states', type: 'sensor_msgs/msg/JointState' },
              { name: '/hsrb/odom', type: 'nav_msgs/msg/Odometry' },
            ],
          },
        },
      ],
    },
    validators: { active: 'loss_report', options: [] },
  },
};

const PRESETS = {
  items: [
    {
      id: 'hsr_required_topics',
      name: 'HSR required topics',
      description: 'Required-topic presence check.',
      pipeline: 'fast_validation',
      params: { template: 'airoa_hsr' },
      total: 2,
      pending: 2,
      pending_capture_ids: ['cap_002', 'cap_001'],
    },
    {
      id: 'greeting_demo',
      name: 'Greeting demo',
      description: 'hello_kairos template plugin.',
      pipeline: 'hello_kairos',
      params: { subject: 'kairos' },
      total: 2,
      pending: 0,
      pending_capture_ids: [],
    },
  ],
};

const RUNTIME_CONFIG = {
  endpoints: { api: '/api/v1', events: '/api/v1/events', webrtc: '/webrtc' },
  tabs: [],
  defaults: {},
  schemas: {
    pipeline_forms: {
      fast_validation: {
        type: 'object',
        required: ['template'],
        properties: { template: { type: 'string' } },
      },
      hello_kairos: {
        type: 'object',
        properties: {
          subject: { type: 'string', title: 'Greeting subject', default: 'kairos' },
          shout: { type: 'boolean', title: 'Shout', default: false },
        },
      },
      loss_report: { type: 'object', properties: {} },
      video_check: {
        type: 'object',
        required: ['topic'],
        properties: { topic: { type: 'string', 'x-suggest': 'camera_topics' } },
      },
    },
  },
};

// One batch of two — cap_001, which is on this host (validatable), and cap_003,
// which is catalogued but whose bytes are elsewhere. The list item is a COUNT
// and carries no row per capture (E-27); membership is read off the captures'
// own `batch_id`, which is what a batch's membership has always been (§4.1).
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

let requestedUrls: string[] = [];
let captureSearchBodies: Record<string, unknown>[] = [];
// Keeps every submitted job in `running`, so polling continues.
let jobStaysRunning = false;
// When true, every capture page reports another page after it, so the client's
// own MAX_PAGES cap is what ends the sweep — the real truncation path, not a
// faked flag.
let capturesNeverEnd = false;

/** capture_id -> the error code POST /jobs answers it with. */
let refuseJobFor: Record<string, string> = {};
let postedBodies: Record<string, unknown>[] = [];
let jobCounter = 0;
let resultByJobId: Record<string, unknown> = {};
let validationRuns: Record<string, Record<string, unknown>> = {};
let selectionCaptureIds: Record<string, string[]> = {};
let validationRunByRequestId: Record<string, Record<string, unknown>> = {};
let validationRequestIds: string[] = [];
let loseFirstValidationRunResponse = false;
let selectionFailures = 0;

beforeEach(() => {
  setApiBase('/api/v1');
  requestedUrls = [];
  captureSearchBodies = [];
  postedBodies = [];
  jobCounter = 0;
  jobStaysRunning = false;
  capturesNeverEnd = false;
  resultByJobId = {};
  validationRuns = {};
  selectionCaptureIds = {};
  validationRunByRequestId = {};
  validationRequestIds = [];
  loseFirstValidationRunResponse = false;
  selectionFailures = 0;
  refuseJobFor = {};
  window.sessionStorage.clear();
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.endsWith('/captures/search')) {
      captureSearchBodies.push(
        JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>,
      );
    }
    if (url.includes('/validation/presets'))
      return Promise.resolve(jsonResponse(PRESETS));
    if (url.includes('/validation/runs')) {
      const method = (init?.method ?? 'GET').toUpperCase();
      const path = url.split('/validation/runs')[1] ?? '';
      if (method === 'GET' && (path === '' || path.startsWith('?'))) {
        return Promise.resolve(jsonResponse({ items: [] }));
      }
      if (method === 'POST' && (path === '' || path.startsWith('?'))) {
        const body = JSON.parse(String((init as RequestInit).body));
        validationRequestIds.push(String(body.request_id));
        const prior = validationRunByRequestId[String(body.request_id)];
        if (prior) return Promise.resolve(jsonResponse(prior, 202));
        const captureIds =
          body.capture_ids ?? selectionCaptureIds[body.selection_id] ?? [];
        for (const capture_id of captureIds) {
          postedBodies.push({
            pipeline: body.pipeline,
            params: body.params ?? {},
            capture_id,
          });
        }
        const runId = `vr-${Object.keys(validationRuns).length + 1}`;
        const run = {
          run_id: runId,
          pipeline: body.pipeline,
          params: body.params ?? {},
          state: jobStaysRunning ? 'running' : 'finished',
          cancel_requested: false,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          completed_at: jobStaysRunning ? null : '2026-01-01T00:01:00Z',
          jobs: captureIds.map((capture_id: string, index: number) => ({
            run_job_id: `rj-${index + 1}`,
            capture_id,
            attempt: 1,
            dispatch_state: refuseJobFor[capture_id] ? 'submission_failed' : 'accepted',
            failure_message: refuseJobFor[capture_id]
              ? `${capture_id} could not be submitted.`
              : null,
            job: refuseJobFor[capture_id]
              ? null
              : {
                  job_id: `j-${index + 1}`,
                  capture_id,
                  pipeline: body.pipeline,
                  state: jobStaysRunning ? 'running' : 'succeeded',
                  progress: jobStaysRunning ? 0.4 : 1,
                },
            result: jobStaysRunning
              ? null
              : (resultByJobId[`for:${capture_id}`] ?? { summary: { result: 'pass' } }),
          })),
        };
        validationRuns[runId] = run;
        validationRunByRequestId[String(body.request_id)] = run;
        if (loseFirstValidationRunResponse) {
          loseFirstValidationRunResponse = false;
          return Promise.reject(new TypeError('connection reset after server commit'));
        }
        return Promise.resolve(jsonResponse(run, 202));
      }
      const runId = path.split('/')[1]?.split('?')[0] ?? '';
      const run = validationRuns[runId];
      if (method === 'POST' && path.endsWith('/cancel') && run) {
        run.state = 'cancel_requested';
        run.cancel_requested = true;
        return Promise.resolve(jsonResponse(run, 202));
      }
      return Promise.resolve(
        jsonResponse(
          run ?? { error: { code: 'validation_run_not_found' } },
          run ? 200 : 404,
        ),
      );
    }
    if (url.endsWith('/capture-selections')) {
      if (selectionFailures > 0) {
        selectionFailures -= 1;
        return Promise.resolve(
          jsonResponse({ error: { code: 'service_unavailable' } }, 503),
        );
      }
      const body = JSON.parse(String((init as RequestInit).body));
      const batchId = body.query?.predicates?.find(
        (predicate: { field?: string }) => predicate.field === 'batch_id',
      )?.value;
      selectionCaptureIds['selection-1'] = batchId
        ? ['cap_001']
        : ['cap_002', 'cap_001'];
      return Promise.resolve(
        jsonResponse(
          {
            selection_id: 'selection-1',
            matched_count: 2,
            expires_at: '2099-01-01T00:00:00Z',
          },
          201,
        ),
      );
    }
    if (url.includes('/batches')) return Promise.resolve(jsonResponse(BATCHES));
    if (url.includes('/config/options')) return Promise.resolve(jsonResponse(OPTIONS));
    if (url.endsWith('/api/v1/config') || url.endsWith('/api/v1/config/')) {
      return Promise.resolve(jsonResponse(RUNTIME_CONFIG));
    }
    if (url.includes('/pipelines')) return Promise.resolve(jsonResponse(PIPELINES));
    if (url.match(/\/jobs\/[^/]+\/status/)) {
      const id = url.split('/jobs/')[1]?.split('/')[0] ?? 'j1';
      return Promise.resolve(
        jsonResponse({
          job_id: id,
          capture_id: 'cap_002',
          pipeline: 'fast_validation',
          // A job that never finishes, so the client keeps polling — the state
          // the "does it stop when the operator leaves" test needs.
          state: jobStaysRunning ? 'running' : 'succeeded',
          progress: jobStaysRunning ? 0.4 : 1,
        }),
      );
    }
    if (url.match(/\/jobs\/[^/]+\/result/)) {
      const id = url.split('/jobs/')[1]?.split('/')[0] ?? 'j1';
      return Promise.resolve(
        jsonResponse(resultByJobId[id] ?? { summary: { result: 'pass' } }),
      );
    }
    if (url.endsWith('/jobs')) {
      const body = JSON.parse(String((init as RequestInit).body));
      postedBodies.push(body);
      const refusal = refuseJobFor[String(body.capture_id)];
      if (refusal) {
        return Promise.resolve(
          jsonResponse(
            { error: { code: refusal, message: `${body.capture_id} is gone` } },
            409,
          ),
        );
      }
      jobCounter += 1;
      const jobId = `j${jobCounter}`;
      // Key results by job id so each posted capture_id can carry its own summary.
      resultByJobId[jobId] = resultByJobId[`for:${body.capture_id}`] ?? {
        summary: { result: 'pass' },
      };
      return Promise.resolve(
        jsonResponse({
          job_id: jobId,
          capture_id: body.capture_id,
          pipeline: body.pipeline,
          // The submit response seeds the status cache, so a terminal state here
          // would stop the poll before it ever started.
          state: jobStaysRunning ? 'running' : 'succeeded',
          progress: jobStaysRunning ? 0.1 : 1,
        }),
      );
    }
    if (url.endsWith('/captures/search')) {
      return Promise.resolve(
        jsonResponse({
          ...(capturesNeverEnd ? { ...CAPTURES, next_cursor: 'more' } : CAPTURES),
          total: CAPTURES.items.length,
          facets: {},
        }),
      );
    }
    if (url.match(/\/captures\/[^/?]+$/)) {
      const id = url.split('/captures/')[1] ?? '';
      const capture = CAPTURES.items.find((c) => c.capture_id === id);
      return Promise.resolve(
        jsonResponse({
          ...(capture ?? {}),
          capture_id: id,
          topics: TOPICS_BY_CAPTURE[id] ?? CAPTURE_TOPICS,
        }),
      );
    }
    if (url.includes('/captures')) {
      return Promise.resolve(
        jsonResponse(
          capturesNeverEnd ? { ...CAPTURES, next_cursor: 'more' } : CAPTURES,
        ),
      );
    }
    return Promise.resolve(jsonResponse({}));
  });
});

afterEach(() => vi.restoreAllMocks());

test('pipeline selection shows only server-reported facts, never fake lifecycle state', async () => {
  renderWithClient(<ValidationScreen />);

  await screen.findByTestId('pipeline-card-fast_validation');
  const detail = () => screen.getByTestId('detail-header');
  expect(within(detail()).getByText('fast_validation')).toBeInTheDocument();
  expect(
    screen.getByText(/Lifecycle and promotion are not configured/),
  ).toBeInTheDocument();

  fireEvent.click(screen.getByTestId('pipeline-card-hello_kairos'));
  await waitFor(() =>
    expect(within(detail()).getByText('hello_kairos')).toBeInTheDocument(),
  );
  expect(screen.queryByText(/STANDARD|CANDIDATE|EXPERIMENTAL/)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Promote/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /New run/ })).not.toBeInTheDocument();
});

test("the schema-driven form renders the selected pipeline's real fields", async () => {
  renderWithClient(<ValidationScreen />);
  fireEvent.click(await screen.findByTestId('pipeline-card-hello_kairos'));
  expect(await screen.findByLabelText('subject')).toBeInTheDocument();
  expect(screen.getByLabelText('shout')).toBeInTheDocument();
});

test('the screen never touches the retired /runs or /episodes resources', async () => {
  renderWithClient(<ValidationScreen />);
  await screen.findByTestId('pipeline-card-fast_validation');
  await waitFor(() =>
    expect((screen.getByLabelText('target') as HTMLSelectElement).value).toBe(
      'cap_002',
    ),
  );
  expect(requestedUrls.some((u) => /\/api\/v1\/(runs|episodes)\b/.test(u))).toBe(false);
  expect(requestedUrls.some((u) => u.includes('/api/v1/captures'))).toBe(true);
  // Datasets are not a job target any more, so the screen does not fetch them.
  expect(requestedUrls.some((u) => u.includes('/datasets'))).toBe(false);
});

test('the default target is the newest capture whose bytes are on this host', async () => {
  renderWithClient(<ValidationScreen />);
  const target = (await screen.findByLabelText('target')) as HTMLSelectElement;
  // cap_003 is newer but has no local replica, so cap_002 is chosen instead.
  await waitFor(() => expect(target.value).toBe('cap_002'));
  expect(await screen.findByTestId('target-availability')).toHaveAttribute(
    'data-availability',
    'verified',
  );
  expect(screen.queryByTestId('target-note')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Run on selection' })).not.toBeDisabled();
});

test('the target selector lists captures and batches, and nothing dataset-shaped', async () => {
  renderWithClient(<ValidationScreen />);
  const target = (await screen.findByLabelText('target')) as HTMLSelectElement;

  expect(within(target).getByRole('group', { name: 'Captures' })).toBeInTheDocument();
  expect(
    within(target).getByRole('group', {
      name: 'Batches (validate every capture of a batch)',
    }),
  ).toBeInTheDocument();
  expect(
    within(target).queryByRole('group', { name: /dataset/i }),
  ).not.toBeInTheDocument();

  // Options are keyed by capture_id and labelled by the display run_id (§1);
  // the unfinalized capture is not offered at all.
  const values = [...target.options].map((o) => o.value);
  expect(values).toContain('cap_002');
  expect(values).not.toContain('cap_live');
  expect(values.some((v) => v.startsWith('dataset:'))).toBe(false);
  expect(within(target).getByRole('option', { name: 'run_002' })).toBeInTheDocument();
  // Only the two captures that are here count towards "all".
  expect(
    within(target).getByRole('option', {
      name: '— All captures on this host (server selection) —',
    }),
  ).toBeInTheDocument();
});

test('a capture whose bytes are not here cannot be run, and the reason is shown', async () => {
  renderWithClient(<ValidationScreen />);
  const target = (await screen.findByLabelText('target')) as HTMLSelectElement;
  await waitFor(() => expect(target.value).toBe('cap_002'));

  // The option itself says which §8 state is in the way.
  expect(
    within(target).getByRole('option', { name: 'run_003 — not here yet' }),
  ).toBeInTheDocument();

  fireEvent.change(target, { target: { value: 'cap_003' } });

  await waitFor(() =>
    expect(screen.getByTestId('target-availability')).toHaveAttribute(
      'data-availability',
      'awaiting_transfer',
    ),
  );
  const note = screen.getByTestId('target-note');
  expect(note).toHaveTextContent(/No copy of this recording is on this machine yet/);
  expect(note).toHaveTextContent(/cannot run until they are on this machine/);
  expect(screen.getByRole('button', { name: 'Run on selection' })).toBeDisabled();
  expect(postedBodies).toHaveLength(0);
});

test('running on a single target capture posts capture_id and renders SummaryResult', async () => {
  resultByJobId['for:cap_002'] = {
    summary: { pipeline: 'hello_kairos', result: 'pass', message: 'hello kairos!' },
  };
  renderWithClient(<ValidationScreen />);
  fireEvent.click(await screen.findByTestId('pipeline-card-hello_kairos'));

  await waitFor(() =>
    expect((screen.getByLabelText('target') as HTMLSelectElement).value).toBe(
      'cap_002',
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Run on selection' }));

  await waitFor(() => expect(postedBodies.length).toBe(1));
  expect(postedBodies[0]).toMatchObject({
    pipeline: 'hello_kairos',
    capture_id: 'cap_002',
  });
  // The job is keyed by the capture alone (§10.5).
  expect(postedBodies[0]).not.toHaveProperty('run_id');
  expect(postedBodies[0]!.params).not.toHaveProperty('dataset_dir');

  await waitFor(() => expect(screen.getByText('hello kairos!')).toBeInTheDocument());
  expect(screen.getByText('PASS')).toBeInTheDocument();
});

test('running on all present captures renders OK/WARNING/FAIL tiles and per-capture rows', async () => {
  resultByJobId['for:cap_002'] = { summary: { result: 'pass' } };
  resultByJobId['for:cap_001'] = { summary: { result: 'fail' } };
  renderWithClient(<ValidationScreen />);
  fireEvent.click(await screen.findByTestId('pipeline-card-hello_kairos'));

  fireEvent.change(await screen.findByLabelText('target'), {
    target: { value: '__all__' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Run on selection' }));

  // The capture that is only catalogued here is not submitted.
  await waitFor(() => expect(postedBodies.length).toBe(2));
  expect((postedBodies.map((b) => b.capture_id) as string[]).sort()).toEqual([
    'cap_001',
    'cap_002',
  ]);

  await waitFor(() => expect(screen.getByText('2 captures')).toBeInTheDocument());
  expect(screen.getByText('OK')).toBeInTheDocument();
  expect(screen.getByText('FAIL')).toBeInTheDocument();
  // Rows are keyed by capture_id but read as the display run_id.
  const rowsSection = screen.getByText('Timeline').closest('div')!
    .parentElement as HTMLElement;
  expect(within(rowsSection).getByText('run_002')).toBeInTheDocument();
  expect(within(rowsSection).getByText('run_001')).toBeInTheDocument();
});

test('Cancel run records a durable server intent', async () => {
  jobStaysRunning = true;
  renderWithClient(<ValidationScreen />);
  fireEvent.click(await screen.findByTestId('pipeline-card-hello_kairos'));
  await waitFor(() =>
    expect((screen.getByLabelText('target') as HTMLSelectElement).value).toBe(
      'cap_002',
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Run on selection' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel run' }));
  await waitFor(() =>
    expect(
      requestedUrls.some((url) => url.endsWith('/validation/runs/vr-1/cancel')),
    ).toBe(true),
  );
});

test('a failed server selection is visible and the operator can retry Run', async () => {
  selectionFailures = 1;
  renderWithClient(<ValidationScreen />);
  fireEvent.change(await screen.findByLabelText('target'), {
    target: { value: '__all__' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Run on selection' }));

  expect(await screen.findByTestId('validation-selection-message')).toHaveTextContent(
    /Could not freeze the server selection/i,
  );
  expect(screen.getByRole('button', { name: 'Run on selection' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Run on selection' }));
  await waitFor(() => expect(postedBodies).toHaveLength(2));
});

test('a reload recovers a lost validation create response with the same request id', async () => {
  loseFirstValidationRunResponse = true;
  const first = renderWithClient(<ValidationScreen />);
  await screen.findByLabelText('target');
  fireEvent.click(screen.getByRole('button', { name: 'Run on selection' }));
  await screen.findByTestId('validation-submit-error');
  first.unmount();

  renderWithClient(<ValidationScreen />);
  await waitFor(() => expect(validationRequestIds).toHaveLength(2));
  expect(new Set(validationRequestIds).size).toBe(1);
  await screen.findByTestId('detail-header');
  expect(window.sessionStorage.getItem('kairos:pending-validation-run:v1')).toBeNull();
});

test('real presets list with pending badges; an up-to-date preset is disabled', async () => {
  renderWithClient(<ValidationScreen />);
  await screen.findByTestId('preset-hsr_required_topics');
  expect(screen.getByText('HSR required topics')).toBeInTheDocument();
  expect(screen.getByText('2 pending')).toBeInTheDocument();
  expect(screen.getByText('up to date')).toBeInTheDocument();
  expect(screen.getByTestId('preset-greeting_demo')).toBeDisabled();
  expect(screen.getByTestId('preset-hsr_required_topics')).not.toBeDisabled();
});

test('clicking a preset runs its pipeline over exactly its pending_capture_ids', async () => {
  resultByJobId['for:cap_002'] = {
    summary: { result: 'pass', missing: [], extra: [] },
  };
  resultByJobId['for:cap_001'] = {
    summary: { result: 'fail', missing: [{ name: '/hsrb/odom' }], extra: [] },
  };
  renderWithClient(<ValidationScreen />);
  fireEvent.click(await screen.findByTestId('preset-hsr_required_topics'));

  await waitFor(() => expect(postedBodies.length).toBe(2));
  expect(postedBodies.every((b) => b.pipeline === 'fast_validation')).toBe(true);
  expect((postedBodies.map((b) => b.capture_id) as string[]).sort()).toEqual([
    'cap_001',
    'cap_002',
  ]);
  // A 2-capture batch renders the OK/WARNING/FAIL breakdown.
  await waitFor(() => expect(screen.getByText('2 captures')).toBeInTheDocument());
});

test('a fast_validation run renders the bespoke required-topics checklist', async () => {
  resultByJobId['for:cap_002'] = {
    summary: {
      pipeline: 'fast_validation',
      result: 'fail',
      missing: [{ name: '/hsrb/odom', type: 'nav_msgs/msg/Odometry' }],
      extra: [{ name: '/camera/head' }],
    },
  };
  renderWithClient(<ValidationScreen />);
  // fast_validation is the default (first) pipeline; target defaults to cap_002.
  await screen.findByTestId('pipeline-card-fast_validation');
  await waitFor(() =>
    expect((screen.getByLabelText('target') as HTMLSelectElement).value).toBe(
      'cap_002',
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Run on selection' }));

  const card = await screen.findByTestId('fast-validation-checklist');
  expect(within(card).getByText('1/2 required')).toBeInTheDocument();
  expect(within(card).getByText('FAIL')).toBeInTheDocument();
  expect(within(card).getByText('/hsrb/joint_states')).toBeInTheDocument();
  expect(within(card).getByText('/hsrb/odom')).toBeInTheDocument();
  expect(within(card).getByText('+1 extra topics not required')).toBeInTheDocument();
});

test("fast_validation shows bagflow's evidence under the checklist", async () => {
  // The checklist answers "are my topics there"; the generic card below it
  // answers "on what basis" — which used to be visible only when the run
  // FAILED, i.e. never when you most wanted to check a pass.
  resultByJobId['for:cap_002'] = {
    summary: {
      pipeline: 'fast_validation',
      version: '2.0.0',
      engine: 'bagflow',
      result: 'pass',
      message: '2/2 required topic pattern(s) matched (2 topic(s))',
      missing: [],
      extra: [],
      checks: [{ node: 'topic_presence', check: 'topic_presence', ok: true }],
    },
    // Artifacts live under report/<pipeline>/<capture_id>/ (§10.5).
    artifacts: ['report/fast_validation/cap_002/flow/flow.yml'],
  };
  renderWithClient(<ValidationScreen />);
  await screen.findByTestId('pipeline-card-fast_validation');
  await waitFor(() =>
    expect((screen.getByLabelText('target') as HTMLSelectElement).value).toBe(
      'cap_002',
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Run on selection' }));

  // Both cards, not one instead of the other.
  await screen.findByTestId('fast-validation-checklist');
  expect(await screen.findByText('bagflow')).toBeInTheDocument();
  // The flow that actually ran is reachable from the result.
  expect(await screen.findByText(/flow\.yml/)).toBeInTheDocument();
});

test('a batch target validates every capture of that batch that is here (blast radius)', async () => {
  renderWithClient(<ValidationScreen />);
  const target = (await screen.findByLabelText('target')) as HTMLSelectElement;
  // The batch member whose bytes are elsewhere is excluded from the count.
  expect(
    await screen.findByRole('option', {
      name: /07\/13 · #4 · pick \(server selection\)/,
    }),
  ).toBeInTheDocument();

  fireEvent.change(target, { target: { value: 'batch:batch_x' } });
  fireEvent.click(screen.getByRole('button', { name: 'Run on selection' }));

  await waitFor(() => expect(postedBodies.length).toBe(1));
  expect(postedBodies[0]).toMatchObject({
    pipeline: 'fast_validation',
    capture_id: 'cap_001',
  });
});

// E-27: the batch list stopped shipping a row per capture. A screen that read
// its bulk targets off those rows loses every batch — silently, since an empty
// optgroup looks exactly like a host with no batches. This one holds the whole
// capture catalog already, so it owes the server nothing but the count.
test('batch targets survive a list that carries no per-capture rows', async () => {
  renderWithClient(<ValidationScreen />);
  const target = (await screen.findByLabelText('target')) as HTMLSelectElement;

  const option = await screen.findByRole('option', {
    name: /07\/13 · #4 · pick/,
  });
  expect(option).toBeInTheDocument();
  expect((option as HTMLOptionElement).value).toBe('batch:batch_x');
  expect((option as HTMLOptionElement).disabled).toBe(false);
  expect(
    within(target).queryByRole('option', { name: 'No batches with captures' }),
  ).not.toBeInTheDocument();
  // Membership came from the captures already on hand, so no batch detail was
  // fetched to rebuild what the screen was holding.
  expect(requestedUrls.some((u) => u.endsWith('/batches/lookup'))).toBe(true);
});

// ---- the catalog sweep's own limit ---------------------------------------
// The targets here are drawn from a cursor sweep that gives up after
// MAX_PAGES. "All captures on this host (N)" and a batch's "(n on this host)"
// are then counts of what was fetched, presented as counts of what exists.

test('a paged catalog says so beside the targets and supports navigation', async () => {
  capturesNeverEnd = true;
  renderWithClient(<ValidationScreen />);

  const note = await screen.findByTestId('catalog-truncated', undefined, {
    timeout: 10000,
  });
  expect(note).toHaveTextContent(/page 1/i);
  expect(note).toHaveTextContent(/server selection/i);
  expect(screen.getByTestId('validation-captures-previous')).toBeDisabled();
  fireEvent.click(screen.getByTestId('validation-captures-next'));
  await waitFor(() =>
    expect(screen.getByTestId('validation-capture-pagination')).toHaveTextContent(
      'Page 2',
    ),
  );
  // The new page gets its own default target; the capture selected before the
  // boundary is never silently retained.
  expect(screen.getByLabelText('target')).toHaveValue('cap_002');
  expect(captureSearchBodies.at(-1)).toMatchObject({ cursor: 'more', limit: 100 });
  fireEvent.click(screen.getByTestId('validation-captures-previous'));
  await waitFor(() =>
    expect(screen.getByTestId('validation-capture-pagination')).toHaveTextContent(
      'Page 1',
    ),
  );
});

test('a catalog that fits reports nothing — the note is not decoration', async () => {
  renderWithClient(<ValidationScreen />);

  await waitFor(() =>
    expect((screen.getByLabelText('target') as HTMLSelectElement).value).toBe(
      'cap_002',
    ),
  );
  expect(screen.queryByTestId('catalog-truncated')).not.toBeInTheDocument();
});

test("video_check's topic param is a picker seeded from the target capture's cameras", async () => {
  renderWithClient(<ValidationScreen />);
  fireEvent.click(await screen.findByTestId('pipeline-card-video_check'));

  // The x-suggest select appears once GET /captures/{id} resolves the target's
  // topics, pre-seeded with its first camera topic — no hand-typing.
  const select = (await screen.findByLabelText('topic')) as HTMLSelectElement;
  await waitFor(() =>
    expect(select.value).toBe('/hsrb/head_rgbd_sensor/rgb/image_rect_color/compressed'),
  );
  expect(select.tagName).toBe('SELECT');
  // Only camera topics are offered, and BOTH of them — cap_002 carries two
  // cameras plus /hsrb/joint_states, which must not appear.
  expect([...select.options].map((o) => o.value)).toEqual([
    '/hsrb/head_rgbd_sensor/rgb/image_rect_color/compressed',
    '/hsrb/hand_camera/image_raw/compressed',
  ]);

  // Running submits the seeded camera topic against the capture.
  fireEvent.click(screen.getByRole('button', { name: 'Run on selection' }));
  await waitFor(() => expect(postedBodies.length).toBe(1));
  expect(postedBodies[0]).toMatchObject({
    pipeline: 'video_check',
    capture_id: 'cap_002',
    params: { topic: '/hsrb/head_rgbd_sensor/rgb/image_rect_color/compressed' },
  });
});

// M4: a preset runs over the captures it has not validated yet. If one of them
// was discarded since that list was computed, the server refuses its job — and
// the loop used to `await` without a catch, so the whole mutation rejected: the
// jobs already created kept running with nothing watching them, and the
// operator got one error that never said which capture it was about.
test('one refused capture does not abandon the rest of a preset run', async () => {
  refuseJobFor['cap_001'] = 'capture_deleting';
  renderWithClient(<ValidationScreen />);
  fireEvent.click(await screen.findByTestId('preset-hsr_required_topics'));

  // Both were attempted …
  await waitFor(() => expect(postedBodies.length).toBe(2));
  // … and the one that COULD run is still tracked, rather than being thrown
  // away with the rejection.
  await waitFor(() =>
    expect(screen.getByTestId('submit-failures')).toBeInTheDocument(),
  );
  const failures = screen.getByTestId('submit-failures');
  // Named, so the operator knows which recording did not get validated, and
  // told what it means rather than shown a bare code.
  expect(failures).toHaveTextContent('cap_001');
  expect(failures.textContent).toMatch(/could not be submitted/i);
});

test('a preset whose captures were all discarded reports it instead of showing a run', async () => {
  refuseJobFor['cap_001'] = 'capture_deleted';
  refuseJobFor['cap_002'] = 'capture_deleted';
  renderWithClient(<ValidationScreen />);
  fireEvent.click(await screen.findByTestId('preset-hsr_required_topics'));

  await waitFor(() =>
    expect(screen.getByTestId('submit-failures')).toBeInTheDocument(),
  );
  expect(screen.getByTestId('submit-failures').textContent).toMatch(
    /could not be submitted/i,
  );
  // No fabricated progress for a run with no jobs in it.
  expect(screen.queryByText('NaN%')).toBeNull();
});

// ---------------------------------------------------------------------------
// E-21: a parameter set for one capture must not be submitted against another.
// `overrides` is cleared when the PIPELINE changes but not when the TARGET
// does, and the x-suggest auto-seed skips any key already present — so a topic
// the operator picked for capture A survived a switch to capture B and went out
// with B's job, naming a topic B does not contain.
// ---------------------------------------------------------------------------

test('a topic chosen for one capture does not carry to the next one', async () => {
  renderWithClient(<ValidationScreen />);
  fireEvent.click(await screen.findByTestId('pipeline-card-video_check'));

  // Target defaults to cap_002. Choose its SECOND camera explicitly — an
  // explicit choice is what lands in `overrides`.
  const select = (await screen.findByLabelText('topic')) as HTMLSelectElement;
  await waitFor(() =>
    expect(select.value).toBe('/hsrb/head_rgbd_sensor/rgb/image_rect_color/compressed'),
  );
  fireEvent.change(select, {
    target: { value: '/hsrb/hand_camera/image_raw/compressed' },
  });
  expect((screen.getByLabelText('topic') as HTMLSelectElement).value).toBe(
    '/hsrb/hand_camera/image_raw/compressed',
  );

  // Switch the target to a capture from a different robot.
  fireEvent.change(screen.getByLabelText('target'), { target: { value: 'cap_001' } });

  // The picker must follow the new capture — the previous robot's camera is not
  // even among its topics, so keeping it would submit a topic that cannot exist.
  await waitFor(() =>
    expect((screen.getByLabelText('topic') as HTMLSelectElement).value).toBe(
      '/myrobot/front_camera/image_raw/compressed',
    ),
  );

  fireEvent.click(screen.getByRole('button', { name: 'Run on selection' }));
  await waitFor(() => expect(postedBodies.length).toBe(1));
  expect(postedBodies[0]).toMatchObject({
    pipeline: 'video_check',
    capture_id: 'cap_001',
    params: { topic: '/myrobot/front_camera/image_raw/compressed' },
  });
});

test('a parameter unrelated to the capture SURVIVES a target switch', async () => {
  // The guard must be about staleness, not about wiping the operator's work:
  // `subject` has nothing to do with which recording is selected, so switching
  // target must leave it alone.
  renderWithClient(<ValidationScreen />);
  fireEvent.click(await screen.findByTestId('pipeline-card-hello_kairos'));

  const subject = (await screen.findByLabelText('subject')) as HTMLInputElement;
  fireEvent.change(subject, { target: { value: 'a deliberate value' } });

  fireEvent.change(screen.getByLabelText('target'), { target: { value: 'cap_001' } });

  expect((screen.getByLabelText('subject') as HTMLInputElement).value).toBe(
    'a deliberate value',
  );
});

// ---------------------------------------------------------------------------
// E-36, the "keeps running after the operator leaves" half. A job is the
// SERVER's work, so it continuing is correct — the question is whether this
// client leaves a poll running behind it. `useJobResult` polls on a
// refetchInterval, which react-query stops when the observer unmounts; pinned
// here because "the poll outlives the screen" is invisible until a machine has
// been open all day.
// ---------------------------------------------------------------------------

/** How many GET /jobs/{id}/status calls have been made. */
function statusPolls() {
  return requestedUrls.filter((u) => /\/validation\/runs\/vr-\d+/.test(u)).length;
}

test('leaving the Validation tab stops the polling it started', async () => {
  jobStaysRunning = true;
  const { unmount } = renderWithClient(<ValidationScreen />);
  fireEvent.click(await screen.findByTestId('pipeline-card-loss_report'));
  fireEvent.click(screen.getByRole('button', { name: 'Run on selection' }));
  await waitFor(() => expect(postedBodies.length).toBe(1));

  // The poll is genuinely live — without this the assertion below would pass on
  // a screen that never polled at all.
  await waitFor(() => expect(statusPolls()).toBeGreaterThanOrEqual(2), {
    timeout: 5000,
  });

  unmount();
  // Let anything already dispatched land, then wait out more than one interval.
  await new Promise((resolve) => setTimeout(resolve, 150));
  const settled = statusPolls();
  await new Promise((resolve) => setTimeout(resolve, 1800));

  expect(statusPolls()).toBe(settled);
});

// #14 — heading structure. This screen must title itself exactly once and
// descend one heading level at a time, so a screen-reader user can navigate it
// by heading instead of reading it as one flat run of text.
test('titles itself with a single h1 and skips no heading level', async () => {
  renderWithClient(<ValidationScreen />);
  await expectScreenHeadingOutline('Validation');
}, 20000);
