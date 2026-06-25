import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { renderWithClient, jsonResponse } from '../../test/renderWithClient';
import { ValidationTab } from './ValidationTab';

const RUNS = { items: [{ run_id: 'run_001', state: 'completed' }], next_cursor: null };
const OPTIONS = {
  validation: {
    active: 'airoa_hsr',
    options: [
      {
        id: 'airoa_hsr',
        name: 'airoa_hsr',
        version: 1,
        required_topics: [
          { name: '/hsrb/joint_states', type: 'sensor_msgs/msg/JointState' },
          { name: '/wrist_wrench', type: null },
        ],
      },
    ],
  },
};

let postedBody: Record<string, unknown> | null = null;

beforeEach(() => {
  setApiBase('/api/v1');
  postedBody = null;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (url.includes('/config/options')) return Promise.resolve(jsonResponse(OPTIONS));
    if (url.includes('/runs')) return Promise.resolve(jsonResponse(RUNS));
    if (url.match(/\/jobs\/[^/]+\/status/))
      return Promise.resolve(jsonResponse({ job_id: 'j1', state: 'succeeded' }));
    if (url.match(/\/jobs\/[^/]+\/result/))
      return Promise.resolve(
        jsonResponse({
          summary: { result: 'fail', missing: [{ name: '/wrist_wrench', type: null }] },
        }),
      );
    if (url.endsWith('/jobs')) {
      postedBody = JSON.parse(String((init as RequestInit).body));
      // fast_validation completes synchronously here → terminal immediately.
      return Promise.resolve(jsonResponse({ job_id: 'j1', state: 'succeeded' }));
    }
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
  fireEvent.click(screen.getByRole('button', { name: '検証を起動' }));

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
