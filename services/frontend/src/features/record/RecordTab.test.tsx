import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import type { RuntimeConfig } from '../../config';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { RecordTab } from './RecordTab';

const CONFIG: RuntimeConfig = {
  endpoints: {
    api: '/api/v1',
    events: '/api/v1/events',
    webrtc: 'http://localhost:8002',
  },
  tabs: [],
  defaults: {},
  schemas: {},
};

// Live graph discovery returned by GET /api/v1/topics. Includes an infra topic
// (/rosout) that the picker must hide.
const TOPICS = {
  topics: [
    { name: '/hsrb/joint_states', type: 'sensor_msgs/msg/JointState' },
    { name: '/hsrb/odom', type: 'nav_msgs/msg/Odometry' },
    { name: '/hsrb/extra', type: 'std_msgs/msg/String' },
    { name: '/rosout', type: 'rcl_interfaces/msg/Log' },
  ],
};

let recordState = 'idle';

beforeEach(() => {
  setApiBase('/api/v1');
  recordState = 'idle';
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (url.includes('/record/start')) {
      recordState = 'recording';
      return Promise.resolve(jsonResponse({ run_id: 'run-1', state: 'recording' }));
    }
    if (url.includes('/record/stop')) {
      recordState = 'idle';
      return Promise.resolve(jsonResponse({ run_id: 'run-1', state: 'completed' }));
    }
    if (url.includes('/record/status')) {
      return Promise.resolve(
        jsonResponse({
          run_id: recordState === 'idle' ? null : 'run-1',
          state: recordState,
        }),
      );
    }
    if (url.includes('/topics')) {
      return Promise.resolve(jsonResponse(TOPICS));
    }
    void init;
    return Promise.resolve(jsonResponse({}));
  });
});

afterEach(() => vi.restoreAllMocks());

test('starts a recording: posts /record/start and reflects recording state', async () => {
  renderWithClient(<RecordTab config={CONFIG} />);

  // Wait for idle status to load.
  await waitFor(() =>
    expect(screen.getByTestId('record-state')).toHaveTextContent('idle'),
  );

  // "Record all topics" sends topics: "all".
  fireEvent.click(screen.getByLabelText('all topics'));
  const startForm = screen.getByLabelText('start recording');
  fireEvent.click(within(startForm).getByRole('button', { name: /Start recording/i }));

  await waitFor(() => {
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
      String(c[0]),
    );
    expect(calls.some((u) => u.includes('/record/start'))).toBe(true);
  });

  // Status query is invalidated and re-fetches -> shows recording.
  await waitFor(() =>
    expect(screen.getByTestId('record-state')).toHaveTextContent('recording'),
  );

  // Stop button appears while active.
  expect(screen.getByRole('button', { name: /Stop recording/i })).toBeInTheDocument();
});

test('pre-selects configured topics from config and records the selected set', async () => {
  const config: RuntimeConfig = {
    ...CONFIG,
    defaults: { default_topics: ['/hsrb/joint_states', '/hsrb/odom'] },
  };
  renderWithClient(<RecordTab config={config} />);

  // Configured topics are pre-checked; the non-configured live topic appears
  // once discovery resolves, unchecked; the infra topic is hidden entirely.
  await waitFor(() =>
    expect(screen.getByLabelText('/hsrb/joint_states')).toBeChecked(),
  );
  expect(screen.getByLabelText('/hsrb/odom')).toBeChecked();
  const extra = await screen.findByLabelText('/hsrb/extra');
  expect(extra).not.toBeChecked();
  expect(screen.queryByLabelText('/rosout')).toBeNull();

  // Add the extra topic, then start.
  fireEvent.click(screen.getByLabelText('/hsrb/extra'));
  const startForm = screen.getByLabelText('start recording');
  fireEvent.click(within(startForm).getByRole('button', { name: /Start recording/i }));

  await waitFor(() => {
    const startCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => String(c[0]).includes('/record/start'),
    );
    expect(startCall).toBeDefined();
    const body = JSON.parse(String((startCall![1] as RequestInit).body));
    expect(new Set(body.topics)).toEqual(
      new Set(['/hsrb/joint_states', '/hsrb/odom', '/hsrb/extra']),
    );
  });
});

test('includes operator and task in the start request when filled', async () => {
  renderWithClient(<RecordTab config={CONFIG} />);
  await waitFor(() =>
    expect(screen.getByTestId('record-state')).toHaveTextContent('idle'),
  );

  fireEvent.click(screen.getByLabelText('all topics'));
  fireEvent.change(screen.getByLabelText('operator'), { target: { value: 'yuki' } });
  fireEvent.change(screen.getByLabelText('task'), { target: { value: 'pick-place' } });
  const startForm = screen.getByLabelText('start recording');
  fireEvent.click(within(startForm).getByRole('button', { name: /Start recording/i }));

  await waitFor(() => {
    const startCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => String(c[0]).includes('/record/start'),
    );
    expect(startCall).toBeDefined();
    const body = JSON.parse(String((startCall![1] as RequestInit).body));
    expect(body.operator).toBe('yuki');
    expect(body.task).toBe('pick-place');
  });
});

test('disables the start form while a session is active (no double start)', async () => {
  recordState = 'recording';
  renderWithClient(<RecordTab config={CONFIG} />);

  await waitFor(() =>
    expect(screen.getByTestId('record-state')).toHaveTextContent('recording'),
  );

  const startForm = screen.getByLabelText('start recording');
  expect(
    within(startForm).getByRole('button', { name: /Start recording/i }),
  ).toBeDisabled();
  expect(screen.getByText(/stop it before starting another/i)).toBeInTheDocument();
});
