import { QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { makeTestClient } from '../../test/renderWithClient';
import { setApiBase } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type { RuntimeConfig } from '../../config';
import { formatHz, useMonitorRows } from './useMonitorRows';

const CONFIG = {
  endpoints: { api: '/api/v1', events: '/api/v1/events', webrtc: '' },
  tabs: [],
  defaults: {
    default_topics: ['/hsrb/joint_states'],
    expected_hz: { '/hsrb/joint_states': 50 },
  },
  schemas: {},
} as RuntimeConfig;

const DISCOVERED = [
  { name: '/hsrb/joint_states', type: 'sensor_msgs/msg/JointState', publisher_count: 1 },
  { name: '/hsrb/odom', type: 'nav_msgs/msg/Odometry', publisher_count: 1 },
];

beforeEach(() => {
  setApiBase('/api/v1');
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    if (String(input).includes('/topics')) {
      return Promise.resolve(
        new Response(JSON.stringify(DISCOVERED), {
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    return Promise.resolve(new Response('{}', { headers: { 'Content-Type': 'application/json' } }));
  });
});

afterEach(() => vi.restoreAllMocks());

test('merges discovery + SSE metrics, sorts configured/measured first, counts measured', async () => {
  const client = makeTestClient();
  // SSE-fed metrics cache: only /hsrb/joint_states is measured (49.6 Hz).
  client.setQueryData(queryKeys.metrics, {
    topics: [{ name: '/hsrb/joint_states', hz: 49.6, bandwidth_bps: 2_000_000 }],
  });

  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);

  const { result } = renderHook(() => useMonitorRows(CONFIG), { wrapper });

  await waitFor(() => expect(result.current.rows.length).toBe(2));

  const rows = result.current.rows;
  // Configured + measured topic sorts first.
  const first = rows[0]!;
  expect(first.name).toBe('/hsrb/joint_states');
  expect(first.configured).toBe(true);
  expect(first.measured).toBe(true);
  expect(first.expected_hz).toBe(50);
  expect(formatHz(first)).toBe('49.6 / 50');
  // Discovered-only topic is not measured.
  const odom = rows.find((r) => r.name === '/hsrb/odom')!;
  expect(odom.measured).toBe(false);
  expect(odom.live).toBe(true);
  expect(result.current.measuredCount).toBe(1);
});
