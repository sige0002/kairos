import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { renderWithClient, jsonResponse } from '../../test/renderWithClient';
import { ValidationScreen } from './ValidationScreen';

const PIPELINES = {
  items: [
    { id: 'fast_validation', name: 'Fast validation', enabled: true },
    { id: 'hello_kairos', name: 'Hello kairos (greeting)', enabled: true },
    { id: 'loss_report', name: 'Loss report', enabled: true },
  ],
};
const RUNS = {
  items: [
    { run_id: 'run_002', state: 'completed' },
    { run_id: 'run_001', state: 'completed' },
  ],
  next_cursor: null,
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
      pending_run_ids: ['run_002', 'run_001'],
    },
    {
      id: 'greeting_demo',
      name: 'Greeting demo',
      description: 'hello_kairos template plugin.',
      pipeline: 'hello_kairos',
      params: { subject: 'kairos' },
      total: 2,
      pending: 0,
      pending_run_ids: [],
    },
  ],
};
const RUNTIME_CONFIG = {
  endpoints: { api: '/api/v1', events: '/api/v1/events', webrtc: '/webrtc' },
  tabs: [],
  defaults: {},
  schemas: {
    pipeline_forms: {
      fast_validation: { type: 'object', required: ['template'], properties: { template: { type: 'string' } } },
      hello_kairos: {
        type: 'object',
        properties: {
          subject: { type: 'string', title: 'Greeting subject', default: 'kairos' },
          shout: { type: 'boolean', title: 'Shout', default: false },
        },
      },
      loss_report: { type: 'object', properties: {} },
    },
  },
};

const DATASETS = {
  datasets: [
    {
      operator: 'op1',
      task: 'pick',
      index: '001',
      dataset_dir: 'op1/pick/001',
      run_id: 'run_ds1',
      message_count: 1000,
      exported_at: '2026-07-13T12:00:00Z',
      batch_seq: 4,
      index_in_batch: 2,
      task_result: 'success',
      quality: 'good',
    },
  ],
};

let postedBodies: Record<string, unknown>[] = [];
let jobCounter = 0;
let resultByRunId: Record<string, unknown> = {};

beforeEach(() => {
  setApiBase('/api/v1');
  postedBodies = [];
  jobCounter = 0;
  resultByRunId = {};
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (url.includes('/validation/presets')) return Promise.resolve(jsonResponse(PRESETS));
    if (url.includes('/datasets')) return Promise.resolve(jsonResponse(DATASETS));
    if (url.includes('/config/options')) return Promise.resolve(jsonResponse(OPTIONS));
    if (url.endsWith('/api/v1/config') || url.endsWith('/api/v1/config/')) {
      return Promise.resolve(jsonResponse(RUNTIME_CONFIG));
    }
    if (url.includes('/pipelines')) return Promise.resolve(jsonResponse(PIPELINES));
    if (url.match(/\/jobs\/[^/]+\/status/)) {
      const id = url.split('/jobs/')[1]?.split('/')[0] ?? 'j1';
      return Promise.resolve(jsonResponse({ job_id: id, state: 'succeeded', progress: 1 }));
    }
    if (url.match(/\/jobs\/[^/]+\/result/)) {
      const id = url.split('/jobs/')[1]?.split('/')[0] ?? 'j1';
      return Promise.resolve(jsonResponse(resultByRunId[id] ?? { summary: { result: 'pass' } }));
    }
    if (url.endsWith('/jobs')) {
      const body = JSON.parse(String((init as RequestInit).body));
      postedBodies.push(body);
      jobCounter += 1;
      const jobId = `j${jobCounter}`;
      // Key results by job id so each posted run_id can carry a distinct summary.
      resultByRunId[jobId] = resultByRunId[`for:${body.run_id}`] ?? { summary: { result: 'pass' } };
      return Promise.resolve(jsonResponse({ job_id: jobId, state: 'succeeded', progress: 1 }));
    }
    if (url.includes('/runs')) return Promise.resolve(jsonResponse(RUNS));
    return Promise.resolve(jsonResponse({}));
  });
});

afterEach(() => vi.restoreAllMocks());

test('selecting a pipeline updates the detail header (name + lifecycle chip)', async () => {
  renderWithClient(<ValidationScreen />);

  await screen.findByTestId('pipeline-card-fast_validation');
  const detail = () => screen.getByTestId('detail-header');
  // First pipeline defaults to Standard.
  await waitFor(() => expect(within(detail()).getByText('STANDARD')).toBeInTheDocument());
  expect(within(detail()).getByText('fast_validation')).toBeInTheDocument();

  fireEvent.click(screen.getByTestId('pipeline-card-hello_kairos'));
  // Second pipeline is the mock Candidate.
  await waitFor(() => expect(within(detail()).getByText('CANDIDATE')).toBeInTheDocument());
  expect(within(detail()).getByText('Promote to Standard…')).toBeInTheDocument();

  fireEvent.click(screen.getByTestId('pipeline-card-loss_report'));
  await waitFor(() => expect(within(detail()).getByText('EXPERIMENTAL')).toBeInTheDocument());
  expect(within(detail()).queryByText('Promote to Standard…')).not.toBeInTheDocument();
});

test('the schema-driven form renders the selected pipeline\'s real fields', async () => {
  renderWithClient(<ValidationScreen />);
  fireEvent.click(await screen.findByTestId('pipeline-card-hello_kairos'));
  expect(await screen.findByLabelText('subject')).toBeInTheDocument();
  expect(screen.getByLabelText('shout')).toBeInTheDocument();
});

test('running on a single target run renders the generic SummaryResult fallback', async () => {
  resultByRunId['for:run_002'] = {
    summary: { pipeline: 'hello_kairos', result: 'pass', message: 'hello kairos!' },
  };
  renderWithClient(<ValidationScreen />);
  fireEvent.click(await screen.findByTestId('pipeline-card-hello_kairos'));

  await waitFor(() =>
    expect((screen.getByLabelText('target') as HTMLSelectElement).value).toBe('run_002'),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Run on selection' }));

  await waitFor(() => expect(postedBodies.length).toBe(1));
  expect(postedBodies[0]).toMatchObject({ pipeline: 'hello_kairos', run_id: 'run_002' });
  await waitFor(() => expect(screen.getByText('hello kairos!')).toBeInTheDocument());
  expect(screen.getByText('PASS')).toBeInTheDocument();
});

test('running on all completed runs renders OK/WARNING/FAIL tiles and per-run rows', async () => {
  resultByRunId['for:run_002'] = { summary: { result: 'pass' } };
  resultByRunId['for:run_001'] = { summary: { result: 'fail' } };
  renderWithClient(<ValidationScreen />);
  fireEvent.click(await screen.findByTestId('pipeline-card-hello_kairos'));

  fireEvent.change(await screen.findByLabelText('target'), {
    target: { value: '__all__' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Run on selection' }));

  await waitFor(() => expect(postedBodies.length).toBe(2));
  await waitFor(() => expect(screen.getByText('2 runs')).toBeInTheDocument());
  expect(screen.getByText('OK')).toBeInTheDocument();
  expect(screen.getByText('FAIL')).toBeInTheDocument();
  const rowsSection = screen.getByText('Timeline').closest('div')!.parentElement as HTMLElement;
  expect(within(rowsSection).getByText('run_002')).toBeInTheDocument();
  expect(within(rowsSection).getByText('run_001')).toBeInTheDocument();
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

test('clicking a preset runs its pipeline over exactly its pending_run_ids', async () => {
  resultByRunId['for:run_002'] = { summary: { result: 'pass', missing: [], extra: [] } };
  resultByRunId['for:run_001'] = {
    summary: { result: 'fail', missing: [{ name: '/hsrb/odom' }], extra: [] },
  };
  renderWithClient(<ValidationScreen />);
  fireEvent.click(await screen.findByTestId('preset-hsr_required_topics'));

  await waitFor(() => expect(postedBodies.length).toBe(2));
  expect(postedBodies.every((b) => b.pipeline === 'fast_validation')).toBe(true);
  expect((postedBodies.map((b) => b.run_id) as string[]).sort()).toEqual(['run_001', 'run_002']);
  // A 2-run batch renders the OK/WARNING/FAIL breakdown.
  await waitFor(() => expect(screen.getByText('2 runs')).toBeInTheDocument());
});

test('a fast_validation run renders the bespoke required-topics checklist', async () => {
  resultByRunId['for:run_002'] = {
    summary: {
      pipeline: 'fast_validation',
      result: 'fail',
      missing: [{ name: '/hsrb/odom', type: 'nav_msgs/msg/Odometry' }],
      extra: [{ name: '/camera/head' }],
    },
  };
  renderWithClient(<ValidationScreen />);
  // fast_validation is the default (first) pipeline; target defaults to run_002.
  await screen.findByTestId('pipeline-card-fast_validation');
  await waitFor(() =>
    expect((screen.getByLabelText('target') as HTMLSelectElement).value).toBe('run_002'),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Run on selection' }));

  const card = await screen.findByTestId('fast-validation-checklist');
  expect(within(card).getByText('1/2 required')).toBeInTheDocument();
  expect(within(card).getByText('FAIL')).toBeInTheDocument();
  expect(within(card).getByText('/hsrb/joint_states')).toBeInTheDocument();
  expect(within(card).getByText('/hsrb/odom')).toBeInTheDocument();
  expect(within(card).getByText('+1 extra topics not required')).toBeInTheDocument();
});

test('the target selector offers exported datasets grouped separately from runs', async () => {
  renderWithClient(<ValidationScreen />);
  const target = (await screen.findByLabelText('target')) as HTMLSelectElement;
  // Both group labels are present, and the dataset carries a labeled option.
  expect(within(target).getByRole('group', { name: 'Runs (before export)' })).toBeInTheDocument();
  expect(within(target).getByRole('group', { name: 'Datasets (exported)' })).toBeInTheDocument();
  expect(await screen.findByRole('option', { name: '07/13 · #4 · pick' })).toBeInTheDocument();
  expect(screen.getByText('Validation only — export stays in Review.')).toBeInTheDocument();
});

test('a dataset target runs a dataset-capable pipeline with params.dataset_dir', async () => {
  renderWithClient(<ValidationScreen />);
  fireEvent.click(await screen.findByTestId('pipeline-card-loss_report'));
  fireEvent.change(await screen.findByLabelText('target'), {
    target: { value: 'dataset:op1/pick/001' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Run on selection' }));

  await waitFor(() => expect(postedBodies.length).toBe(1));
  // run_id is the dataset's own run_id; the exported dir goes in params.
  expect(postedBodies[0]).toMatchObject({
    pipeline: 'loss_report',
    run_id: 'run_ds1',
    params: { dataset_dir: 'op1/pick/001' },
  });
});

test('a dataset target disables run-only pipelines with an "applies to runs" note', async () => {
  renderWithClient(<ValidationScreen />);
  await screen.findByTestId('pipeline-card-fast_validation'); // default selection
  fireEvent.change(await screen.findByLabelText('target'), {
    target: { value: 'dataset:op1/pick/001' },
  });

  // fast_validation reads a run directly -> not applicable to a dataset target.
  const fast = screen.getByTestId('pipeline-card-fast_validation');
  await waitFor(() => expect(within(fast).getByText('applies to runs')).toBeInTheDocument());
  expect(screen.getByRole('button', { name: 'Run on selection' })).toBeDisabled();
  // loss_report stays applicable (dataset-capable).
  expect(within(screen.getByTestId('pipeline-card-loss_report')).queryByText('applies to runs')).toBeNull();
});
