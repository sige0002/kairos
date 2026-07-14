import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type { AlertEvent, MetricsSnapshot } from '../../api/types';
import type { RuntimeConfig } from '../../config';
import { jsonResponse, makeTestClient, renderWithClient } from '../../test/renderWithClient';
import { OverviewView } from './OverviewView';

const CONFIG = {
  endpoints: { api: '/api/v1', events: '/api/v1/events', webrtc: 'http://localhost:8002' },
  tabs: [],
  defaults: { robot_name: 'hsr', default_topics: ['/hsrb/joint_states'], expected_hz: {} },
  schemas: {},
} as unknown as RuntimeConfig;

const DISCOVERED = [
  { name: '/hsrb/joint_states', type: 'sensor_msgs/msg/JointState', publisher_count: 1 },
  { name: '/hsrb/odom', type: 'nav_msgs/msg/Odometry', publisher_count: 1 },
];

function mockFetch(recordStatus: Record<string, unknown> = { state: 'created', run_id: null }) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/record/status')) return Promise.resolve(jsonResponse(recordStatus));
    if (url.includes('/topics')) return Promise.resolve(jsonResponse(DISCOVERED));
    if (url.includes('/system')) {
      return Promise.resolve(jsonResponse({ cpu: { model: 'Test CPU', cores: 8 }, gpu: null }));
    }
    return Promise.resolve(jsonResponse({}));
  });
}

beforeEach(() => setApiBase('/api/v1'));
afterEach(() => vi.restoreAllMocks());

test('STANDBY + a health tally with the danger topic clickable through to Topics', async () => {
  mockFetch();
  const client = makeTestClient();
  const metrics: MetricsSnapshot = {
    topics: [{ name: '/hsrb/joint_states', hz: 2, status: 'danger' }],
  };
  client.setQueryData(queryKeys.metrics, metrics);
  const onOpenTopics = vi.fn();
  renderWithClient(
    <OverviewView config={CONFIG} onOpenTopics={onOpenTopics} onOpenSignals={vi.fn()} />,
    { client },
  );

  await waitFor(() => expect(screen.getByTestId('overview-record-state')).toHaveTextContent('STANDBY'));
  // Tally shows 1 danger topic and lists it by name.
  await waitFor(() => expect(screen.getByTestId('tally-danger')).toHaveTextContent('1'));
  const attn = screen.getByTestId('attention-/hsrb/joint_states');
  fireEvent.click(attn);
  expect(onOpenTopics).toHaveBeenCalledWith('/hsrb/joint_states');
});

test('honest "no metrics yet" state when topics are discovered but unmeasured', async () => {
  mockFetch();
  renderWithClient(
    <OverviewView config={CONFIG} onOpenTopics={vi.fn()} onOpenSignals={vi.fn()} />,
  );
  await waitFor(() => expect(screen.getByTestId('overview-health-nometrics')).toBeInTheDocument());
});

test('active incidents come from the real alert buffer; empty state is honest', async () => {
  mockFetch();
  const client = makeTestClient();
  const alerts: AlertEvent[] = [
    { topic: '/cam/image', metric: 'gap', op: 'gt', threshold: 100, value: 250, state: 'firing' },
  ];
  client.setQueryData(queryKeys.alerts, alerts);
  renderWithClient(
    <OverviewView config={CONFIG} onOpenTopics={vi.fn()} onOpenSignals={vi.fn()} />,
    { client },
  );
  await waitFor(() => expect(screen.getAllByTestId('overview-incident-row')).toHaveLength(1));
  expect(screen.getByTestId('overview-incidents')).toHaveTextContent('1 firing');
});

test('REC context when a recording is running (no fabricated episode number)', async () => {
  mockFetch({ state: 'recording', run_id: 'run_x', started_at: '2026-07-14T10:00:00Z' });
  renderWithClient(
    <OverviewView config={CONFIG} onOpenTopics={vi.fn()} onOpenSignals={vi.fn()} />,
  );
  await waitFor(() => expect(screen.getByTestId('overview-record-state')).toHaveTextContent('REC'));
  expect(screen.getByTestId('overview-record')).toHaveTextContent('run_x');
});

test('the Signals jump link fires onOpenSignals', async () => {
  mockFetch();
  const onOpenSignals = vi.fn();
  renderWithClient(
    <OverviewView config={CONFIG} onOpenTopics={vi.fn()} onOpenSignals={onOpenSignals} />,
  );
  fireEvent.click(await screen.findByTestId('overview-open-signals'));
  expect(onOpenSignals).toHaveBeenCalled();
});
