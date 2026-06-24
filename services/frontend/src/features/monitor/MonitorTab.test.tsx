import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { queryKeys } from '../../api/queryKeys';
import { dispatchSseEvent } from '../../sse/useEventStream';
import type { AlertEvent } from '../../api/types';
import type { RuntimeConfig } from '../../config';
import {
  jsonResponse,
  makeTestClient,
  renderWithClient,
} from '../../test/renderWithClient';
import { MonitorTab } from './MonitorTab';

const CONFIG: RuntimeConfig = {
  endpoints: { api: '/api/v1', events: '/api/v1/events', webrtc: '' },
  tabs: [],
  defaults: {
    default_topics: ['/hsrb/joint_states', '/camera/*/image_raw'],
    expected_hz: { '/hsrb/joint_states': 50 },
  },
  schemas: {},
};

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse([]));
});
afterEach(() => vi.restoreAllMocks());

test('overlays live metrics from the SSE cache onto discovered topics', async () => {
  const client = makeTestClient();
  // expected_hz comes from config (the backend payload has no expected_hz).
  const cfg: RuntimeConfig = {
    ...CONFIG,
    defaults: { expected_hz: { '/camera/head/image_raw': 30 } },
  };

  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    jsonResponse({ topics: [{ name: '/camera/head/image_raw', publisher_count: 1 }] }),
  );

  renderWithClient(<MonitorTab config={cfg} />, { client });

  await waitFor(() =>
    expect(screen.getByText('/camera/head/image_raw')).toBeInTheDocument(),
  );

  // A metrics snapshot arrives over SSE (real backend field names: name + hz +
  // bandwidth_bps) -> the row shows live Hz/bandwidth.
  dispatchSseEvent(
    client,
    'metrics',
    JSON.stringify({
      ts: '2026-06-24T00:00:00Z',
      window_s: 5,
      topics: [
        { name: '/camera/head/image_raw', hz: 29.7, bandwidth_bps: 2_000_000 },
      ],
    }),
  );

  await waitFor(() => expect(screen.getByText('29.7 / 30')).toBeInTheDocument());
  expect(screen.getByText('2.0 Mbps')).toBeInTheDocument();
});

test('always lists every graph topic and flags configured + measured', async () => {
  const client = makeTestClient();

  // Discovery lists three topics; only one is also measured (via SSE metrics).
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    jsonResponse({
      topics: [
        { name: '/hsrb/joint_states', type: 'sensor_msgs/JointState', publisher_count: 1 },
        { name: '/camera/head/image_raw', type: 'sensor_msgs/Image', publisher_count: 1 },
        { name: '/hsrb/odom', type: 'nav_msgs/Odometry', publisher_count: 1 },
      ],
    }),
  );

  renderWithClient(<MonitorTab config={CONFIG} />, { client });

  // All three appear from discovery even before any metrics arrive.
  await waitFor(() =>
    expect(screen.getByText('/hsrb/odom')).toBeInTheDocument(),
  );
  expect(screen.getByText('/hsrb/joint_states')).toBeInTheDocument();
  expect(screen.getByText('/camera/head/image_raw')).toBeInTheDocument();

  const table = screen.getByRole('table', { name: 'topic health' });
  // /hsrb/joint_states (exact) and /camera/head/image_raw (glob) are configured.
  const jointRow = screen.getByText('/hsrb/joint_states').closest('tr')!;
  expect(within(jointRow).getByText('configured')).toBeInTheDocument();
  // Not-configured, not-measured topic is marked "not measured".
  const odomRow = screen.getByText('/hsrb/odom').closest('tr')!;
  expect(within(odomRow).getByText('not measured')).toBeInTheDocument();

  // A metrics snapshot for one topic overlays its live Hz.
  dispatchSseEvent(
    client,
    'metrics',
    JSON.stringify({
      topics: [{ name: '/hsrb/joint_states', hz: 49.6 }],
    }),
  );
  // expected_hz (50) is resolved from config.defaults.expected_hz, not the payload.
  await waitFor(() =>
    expect(within(table).getByText('49.6 / 50')).toBeInTheDocument(),
  );
});

test('shows alerts from the SSE alert cache', async () => {
  const client = makeTestClient();
  const alert: AlertEvent = {
    topic: '/joint_states',
    metric: 'hz',
    op: 'lt',
    threshold: 100,
    value: 12,
    state: 'firing',
  };
  client.setQueryData<AlertEvent[]>(queryKeys.alerts, [alert]);

  renderWithClient(<MonitorTab />, { client });

  await waitFor(() => expect(screen.getByText('/joint_states')).toBeInTheDocument());
  expect(screen.getByText(/hz lt 100/)).toBeInTheDocument();
  expect(screen.getByText(/firing/)).toBeInTheDocument();
});
