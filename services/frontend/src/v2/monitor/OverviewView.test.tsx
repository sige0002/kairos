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

// An idle recorder answers with an EMPTY live list — that array is what says
// "nothing is live" (§10 rev.2.4); its absence would mean something else.
const IDLE_STATUS = { state: 'created', run_id: null, live_capture_ids: [] };

function mockFetch(recordStatus: Record<string, unknown> = IDLE_STATUS) {
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

test('REC context shows the run name AND the capture identity it is keyed by', async () => {
  mockFetch({
    state: 'recording',
    run_id: 'run_x',
    capture_id: '0199aaaa-0000-7000-8000-00000000000a',
    live_capture_ids: ['0199aaaa-0000-7000-8000-00000000000a'],
    started_at: '2026-07-14T10:00:00Z',
  });
  renderWithClient(
    <OverviewView config={CONFIG} onOpenTopics={vi.fn()} onOpenSignals={vi.fn()} />,
  );
  await waitFor(() => expect(screen.getByTestId('overview-record-state')).toHaveTextContent('REC'));
  expect(screen.getByTestId('overview-record')).toHaveTextContent('run_x');
  expect(screen.getByTestId('overview-record-capture')).toHaveTextContent(
    '0199aaaa-0000-7000-8000-00000000000a',
  );
});

// §10 rev.2.4: a status response without live_capture_ids is an unreachable or
// too-old recorder. Showing STANDBY there would be a claim we have not verified.
test('a status response without live_capture_ids is not shown as STANDBY', async () => {
  mockFetch({ state: 'created', run_id: null });
  renderWithClient(
    <OverviewView config={CONFIG} onOpenTopics={vi.fn()} onOpenSignals={vi.fn()} />,
  );
  await waitFor(() =>
    expect(screen.getByTestId('overview-record-state')).toHaveTextContent(
      'LIVE STATE UNREPORTED',
    ),
  );
  expect(screen.getByTestId('overview-record')).toHaveTextContent(
    'cannot be confirmed that nothing is recording',
  );
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
