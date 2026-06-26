import { QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { makeTestClient } from '../../test/renderWithClient';
import { setApiBase } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type { RuntimeConfig } from '../../config';
import {
  formatHz,
  formatRateShortfall,
  rowTone,
  statusTone,
  useMonitorRows,
  type MonitorRow,
} from './useMonitorRows';

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

const row = (p: Partial<MonitorRow>): MonitorRow =>
  ({ name: '/t', configured: false, live: true, measured: true, ...p }) as MonitorRow;

test('statusTone maps backend status to a row colour', () => {
  expect(statusTone('ok')).toBe('green');
  expect(statusTone('warning')).toBe('amber');
  expect(statusTone('danger')).toBe('red');
  expect(statusTone('inactive')).toBe('red');
  expect(statusTone('unknown')).toBe('gray');
  expect(statusTone(undefined)).toBe('gray');
});

test('rowTone prefers status, stays gray when unmeasured', () => {
  expect(rowTone(row({ measured: false, status: 'danger' }))).toBe('gray');
  expect(rowTone(row({ status: 'warning' }))).toBe('amber');
  // Fallback for status-less snapshots: loss_rate>0 -> amber.
  expect(rowTone(row({ status: undefined, loss_rate: 0.1 }))).toBe('amber');
  expect(rowTone(row({ status: undefined, loss_rate: 0 }))).toBe('green');
});

test('formatRateShortfall: badge only for notable statuses', () => {
  expect(formatRateShortfall(row({ status: 'inactive', rate_shortfall: 1 }))).toBe('silent');
  expect(formatRateShortfall(row({ status: 'danger', rate_shortfall: 0.5 }))).toBe('50%');
  expect(formatRateShortfall(row({ status: 'warning', rate_shortfall: 0.03 }))).toBe('3.0%');
  // `ok` with a sub-threshold shortfall must NOT show a (misleading green) badge.
  expect(formatRateShortfall(row({ status: 'ok', rate_shortfall: 0.01 }))).toBeNull();
  expect(formatRateShortfall(row({ status: 'ok', rate_shortfall: 0 }))).toBeNull();
  expect(formatRateShortfall(row({ status: 'unknown' }))).toBeNull();
});
