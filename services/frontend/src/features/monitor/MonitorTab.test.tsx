import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { queryKeys } from '../../api/queryKeys';
import { dispatchSseEvent } from '../../sse/useEventStream';
import type { AlertEvent } from '../../api/types';
import {
  jsonResponse,
  makeTestClient,
  renderWithClient,
} from '../../test/renderWithClient';
import { MonitorTab } from './MonitorTab';

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse([]));
});
afterEach(() => vi.restoreAllMocks());

test('renders live metrics pushed via the SSE cache and falls back to REST discovery', async () => {
  const client = makeTestClient();

  // Before metrics arrive, REST discovery feeds the table.
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    jsonResponse([{ name: '/scan', type: 'sensor_msgs/LaserScan' }]),
  );

  renderWithClient(<MonitorTab />, { client });

  await waitFor(() => expect(screen.getByText('/scan')).toBeInTheDocument());

  // Now a metrics snapshot arrives over SSE -> table switches to live rows.
  dispatchSseEvent(
    client,
    'metrics',
    JSON.stringify({
      topics: [
        {
          topic: '/camera/head/image_raw',
          hz: 29.7,
          expected_hz: 30,
          bandwidth_bps: 2_000_000,
        },
      ],
    }),
  );

  await waitFor(() =>
    expect(screen.getByText('/camera/head/image_raw')).toBeInTheDocument(),
  );
  expect(screen.getByText('29.7 / 30')).toBeInTheDocument();
  expect(screen.getByText('2.0 Mbps')).toBeInTheDocument();
});

test('shows alerts from the SSE alert cache', async () => {
  const client = makeTestClient();
  const alert: AlertEvent = {
    topic: '/joint_states',
    metric: 'hz',
    level: 'critical',
    value: 12,
    threshold: 100,
  };
  client.setQueryData<AlertEvent[]>(queryKeys.alerts, [alert]);

  renderWithClient(<MonitorTab />, { client });

  await waitFor(() => expect(screen.getByText('/joint_states')).toBeInTheDocument());
  expect(screen.getByText(/threshold 100/)).toBeInTheDocument();
});
