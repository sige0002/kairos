import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { renderWithClient, jsonResponse } from '../../test/renderWithClient';
import { ValidationTab } from './ValidationTab';

const RUNS = {
  items: [
    { run_id: 'run_001', state: 'completed' },
    { run_id: 'run_002', state: 'completed' },
  ],
  next_cursor: null,
};
const PIPELINES = {
  items: [
    { id: 'fast_validation', name: 'Fast validation', enabled: true },
    { id: 'hello_kairos', name: 'Hello kairos (greeting)', enabled: true },
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
              { name: '/wrist_wrench', type: null },
            ],
          },
        },
      ],
    },
    validators: { active: 'loss_report', options: [] },
  },
};

let postedBody: Record<string, unknown> | null = null;
let postedBodies: Record<string, unknown>[] = [];
let jobCounter = 0;
// Each test can swap the presets list and the terminal job result the mock serves.
let presetsPayload: unknown = { items: [] };
let resultPayload: unknown = {
  summary: { result: 'fail', missing: [{ name: '/wrist_wrench', type: null }] },
};

beforeEach(() => {
  setApiBase('/api/v1');
  postedBody = null;
  postedBodies = [];
  jobCounter = 0;
  presetsPayload = { items: [] };
  resultPayload = {
    summary: { result: 'fail', missing: [{ name: '/wrist_wrench', type: null }] },
  };
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (url.includes('/config/options')) return Promise.resolve(jsonResponse(OPTIONS));
    if (url.includes('/pipelines')) return Promise.resolve(jsonResponse(PIPELINES));
    if (url.includes('/validation/presets')) return Promise.resolve(jsonResponse(presetsPayload));
    if (url.match(/\/jobs\/[^/]+\/status/)) {
      const id = url.split('/jobs/')[1]?.split('/')[0] ?? 'j1';
      return Promise.resolve(jsonResponse({ job_id: id, state: 'succeeded' }));
    }
    if (url.match(/\/jobs\/[^/]+\/result/))
      return Promise.resolve(jsonResponse(resultPayload));
    if (url.endsWith('/jobs')) {
      const body = JSON.parse(String((init as RequestInit).body));
      postedBody = body;
      postedBodies.push(body);
      jobCounter += 1;
      return Promise.resolve(jsonResponse({ job_id: `j${jobCounter}`, state: 'succeeded' }));
    }
    if (url.includes('/runs')) return Promise.resolve(jsonResponse(RUNS));
    return Promise.resolve(jsonResponse({}));
  });
});

afterEach(() => vi.restoreAllMocks());

test('submits fast_validation with a run_id and renders the pass/fail result', async () => {
  renderWithClient(<ValidationTab />);

  // The completed run shows up in the selector.
  await waitFor(() =>
    expect((screen.getByLabelText('run') as HTMLSelectElement).querySelector('option[value="run_001"]')).not.toBeNull(),
  );
  fireEvent.change(screen.getByLabelText('run'), { target: { value: 'run_001' } });
  fireEvent.click(screen.getByRole('button', { name: 'Run validation' }));

  // Contract: the job carries a run_id (codex finding) + the chosen template.
  await waitFor(() => expect(postedBody).not.toBeNull());
  expect(postedBody).toMatchObject({
    pipeline: 'fast_validation',
    run_id: 'run_001',
    params: { template: 'airoa_hsr' },
  });

  // Result table shows the missing topic as FAIL.
  await waitFor(() => expect(screen.getByText('FAIL')).toBeInTheDocument());
  expect(screen.getByText('/wrist_wrench')).toBeInTheDocument();
});

test('runs a plugin pipeline and renders its generic summary result', async () => {
  resultPayload = {
    summary: {
      pipeline: 'hello_kairos',
      version: '0.1.0',
      result: 'pass',
      message: 'hello kairos!',
      metrics: { subject: 'kairos', characters: 13 },
    },
    artifacts: ['/data/report/hello_kairos/run_001/summary.json'],
  };
  renderWithClient(<ValidationTab />);

  // The pipeline select is populated from GET /pipelines (backend-driven).
  await waitFor(() =>
    expect(
      (screen.getByLabelText('pipeline') as HTMLSelectElement).querySelector(
        'option[value="hello_kairos"]',
      ),
    ).not.toBeNull(),
  );
  fireEvent.change(screen.getByLabelText('pipeline'), { target: { value: 'hello_kairos' } });
  fireEvent.change(screen.getByLabelText('run'), { target: { value: 'run_001' } });
  fireEvent.click(screen.getByRole('button', { name: 'Run pipeline' }));

  // The job forwards the selected pipeline + run_id with no pipeline-specific code.
  await waitFor(() => expect(postedBody).not.toBeNull());
  expect(postedBody).toMatchObject({ pipeline: 'hello_kairos', run_id: 'run_001' });

  // The generic renderer surfaces the plugin's summary.json (message + PASS).
  await waitFor(() => expect(screen.getByText('hello kairos!')).toBeInTheDocument());
  expect(screen.getByText('PASS')).toBeInTheDocument();
});

test('one-click preset runs a batch over its pending runs', async () => {
  presetsPayload = {
    items: [
      {
        id: 'greeting_demo',
        name: 'Greeting demo',
        description: 'hello_kairos template',
        pipeline: 'hello_kairos',
        params: { subject: 'kairos' },
        total: 2,
        pending: 2,
        pending_run_ids: ['run_001', 'run_002'],
      },
    ],
  };
  resultPayload = { summary: { pipeline: 'hello_kairos', result: 'pass', message: 'hello kairos!' } };
  renderWithClient(<ValidationTab />);

  // The preset button appears with its pending count and one click runs both.
  const presetButton = await screen.findByRole('button', { name: /Greeting demo/ });
  expect(presetButton).toHaveTextContent('2 pending');
  fireEvent.click(presetButton);

  // One /jobs call per pending run, all with the preset's pipeline + params.
  await waitFor(() => expect(postedBodies.length).toBe(2));
  expect(postedBodies.map((b) => b.run_id)).toEqual(['run_001', 'run_002']);
  expect(postedBodies[0]).toMatchObject({ pipeline: 'hello_kairos', params: { subject: 'kairos' } });

  // The batch list shows a row per run, each terminal as PASS.
  const batch = await screen.findByText('Batch');
  const batchCard = batch.closest('div')!.parentElement as HTMLElement;
  expect(within(batchCard).getByText('run_001')).toBeInTheDocument();
  expect(within(batchCard).getByText('run_002')).toBeInTheDocument();
  await waitFor(() => expect(within(batchCard).getAllByText('PASS').length).toBe(2));
});

test('target "All completed runs" fans the pipeline out over every completed run', async () => {
  resultPayload = { summary: { pipeline: 'hello_kairos', result: 'pass', message: 'hi' } };
  renderWithClient(<ValidationTab />);

  await waitFor(() =>
    expect((screen.getByLabelText('run') as HTMLSelectElement).querySelector('option[value="__all__"]')).not.toBeNull(),
  );
  fireEvent.change(screen.getByLabelText('pipeline'), { target: { value: 'hello_kairos' } });
  fireEvent.change(screen.getByLabelText('run'), { target: { value: '__all__' } });
  fireEvent.click(screen.getByRole('button', { name: 'Run on all (2)' }));

  await waitFor(() => expect(postedBodies.length).toBe(2));
  expect(postedBodies.map((b) => b.run_id)).toEqual(['run_001', 'run_002']);
});
