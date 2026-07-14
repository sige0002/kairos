import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { useUiStore } from '../../store/uiStore';
import { __resetPanelStore } from './panelStore';
import { MonitorScreen } from './MonitorScreen';

const CONFIG = {
  endpoints: { api: '/api/v1', events: '/api/v1/events', webrtc: 'http://localhost:8002' },
  tabs: [],
  defaults: {
    robot_name: 'hsr',
    ros_domain_id: 42,
    default_topics: ['/hsrb/joint_states'],
    expected_hz: { '/hsrb/joint_states': 50 },
  },
  schemas: {},
};

const DISCOVERED = [
  { name: '/hsrb/joint_states', type: 'sensor_msgs/msg/JointState', publisher_count: 1 },
  { name: '/hsrb/odom', type: 'nav_msgs/msg/Odometry', publisher_count: 1 },
];

function mockFetch(recordStatus: Record<string, unknown> = { state: 'created', run_id: null }) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/config')) return Promise.resolve(jsonResponse(CONFIG));
    if (url.includes('/record/status')) return Promise.resolve(jsonResponse(recordStatus));
    if (url.includes('/topics')) return Promise.resolve(jsonResponse(DISCOVERED));
    if (url.includes('/system')) {
      return Promise.resolve(jsonResponse({ cpu: { model: 'Test CPU', cores: 8 }, gpu: null }));
    }
    return Promise.resolve(jsonResponse({}));
  });
}

/** Navigate into the Topics sub-view (default landing is Overview). */
async function gotoTopics() {
  fireEvent.click(await screen.findByTestId('mon-nav-Topics'));
}

beforeEach(() => {
  setApiBase('/api/v1');
  __resetPanelStore();
  useUiStore.setState({
    activeTab: 'monitor',
    sseStatus: 'closed',
    monitorBridge: null,
    recMarkers: [],
    recMarkersPrevActive: null,
    probeSeries: [],
    recordSelected: new Set<string>(),
    recordCustomized: false,
    recordSeededKey: null,
  });
});
afterEach(() => vi.restoreAllMocks());

test('lands on Overview: the diagnostic landing, not a fabricated episode', async () => {
  mockFetch();
  renderWithClient(<MonitorScreen />);

  await waitFor(() => expect(screen.getByTestId('monitor-overview')).toBeInTheDocument());
  expect(screen.getByTestId('mon-nav-Overview')).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByTestId('overview-record-state')).toHaveTextContent('STANDBY');
  expect(screen.getByTestId('overview-open-topics')).toBeInTheDocument();
  expect(screen.getByTestId('overview-open-signals')).toBeInTheDocument();
});

test('nav is in §11 spec order', async () => {
  mockFetch();
  renderWithClient(<MonitorScreen />);
  await screen.findByTestId('mon-nav-Overview');
  for (const label of ['Overview', 'Topics', 'Signals', 'System', 'Events', 'Logs']) {
    expect(screen.getByTestId(`mon-nav-${label}`)).toBeInTheDocument();
  }
});

test('Overview → "chart →" on a danger topic opens Topics with that topic charted', async () => {
  mockFetch();
  const { client } = renderWithClient(<MonitorScreen />);
  client.setQueryData(['metrics'], {
    topics: [{ name: '/hsrb/joint_states', hz: 1, status: 'danger' }],
  });

  const attn = await screen.findByTestId('attention-/hsrb/joint_states');
  fireEvent.click(attn);

  await waitFor(() =>
    expect(screen.getByTestId('freq-legend-/hsrb/joint_states')).toBeInTheDocument(),
  );
});

test('Topics: chart defaults to the first discovered topic, table lists both', async () => {
  mockFetch();
  renderWithClient(<MonitorScreen />);
  await gotoTopics();

  await waitFor(() =>
    expect(screen.getByTestId('topic-row-/hsrb/joint_states')).toBeInTheDocument(),
  );
  expect(screen.getByTestId('topic-row-/hsrb/odom')).toBeInTheDocument();
  expect(screen.getByTestId('topic-row-/hsrb/joint_states')).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByTestId('freq-legend-/hsrb/joint_states')).toBeInTheDocument();
});

test('Topics: clicking a second topic overlays it; clicking again removes it', async () => {
  mockFetch();
  renderWithClient(<MonitorScreen />);
  await gotoTopics();

  await waitFor(() => expect(screen.getByTestId('topic-row-/hsrb/odom')).toBeInTheDocument());
  expect(screen.getByTestId('topic-row-/hsrb/odom')).toHaveAttribute('aria-pressed', 'false');

  fireEvent.click(screen.getByTestId('topic-row-/hsrb/odom'));
  await waitFor(() =>
    expect(screen.getByTestId('topic-row-/hsrb/odom')).toHaveAttribute('aria-pressed', 'true'),
  );
  expect(screen.getByTestId('freq-legend-/hsrb/odom')).toBeInTheDocument();

  fireEvent.click(screen.getByTestId('topic-row-/hsrb/odom'));
  await waitFor(() =>
    expect(screen.getByTestId('topic-row-/hsrb/odom')).toHaveAttribute('aria-pressed', 'false'),
  );
  expect(screen.queryByTestId('freq-legend-/hsrb/odom')).not.toBeInTheDocument();
});

test('sub-nav switches between the real built-out views (no placeholders)', async () => {
  mockFetch();
  renderWithClient(<MonitorScreen />);
  await screen.findByTestId('mon-nav-System');

  fireEvent.click(screen.getByTestId('mon-nav-System'));
  expect(await screen.findByTestId('monitor-system')).toBeInTheDocument();

  fireEvent.click(screen.getByTestId('mon-nav-Events'));
  expect(screen.getByTestId('monitor-events')).toBeInTheDocument();

  fireEvent.click(screen.getByTestId('mon-nav-Logs'));
  expect(screen.getByTestId('monitor-logs')).toBeInTheDocument();

  // No leftover "not built yet" placeholder anywhere.
  expect(screen.queryByText(/isn't built yet/)).not.toBeInTheDocument();

  fireEvent.click(screen.getByTestId('mon-nav-Topics'));
  await waitFor(() => expect(screen.getByTestId('topic-row-/hsrb/odom')).toBeInTheDocument());
});

test('← Back to Collect switches the active tab', async () => {
  mockFetch();
  renderWithClient(<MonitorScreen />);
  await screen.findByTestId('mon-nav-Topics');

  fireEvent.click(screen.getByRole('button', { name: /Back to Collect/ }));
  expect(useUiStore.getState().activeTab).toBe('collect');
});

test('context strip: STANDBY when no recording is active (no fabricated episode)', async () => {
  mockFetch({ state: 'created', run_id: null });
  renderWithClient(<MonitorScreen />);

  await waitFor(() => expect(screen.getByTestId('context-state')).toHaveTextContent('STANDBY'));
  expect(screen.queryByText(/Episode #27/)).not.toBeInTheDocument();
  expect(screen.queryByText(/FROM COLLECT WARNING/)).not.toBeInTheDocument();
});

test('context strip: REC + run_id shown while a real recording is running', async () => {
  mockFetch({ state: 'recording', run_id: 'run_test', started_at: '2026-07-13T15:00:00Z' });
  renderWithClient(<MonitorScreen />);

  await waitFor(() => expect(screen.getByTestId('context-state')).toHaveTextContent('REC'));
  expect(screen.getByTestId('monitor-context')).toHaveTextContent('run_test');
});

test('Topics Events card: honest empty state when the alert buffer is empty', async () => {
  mockFetch();
  renderWithClient(<MonitorScreen />);
  await gotoTopics();
  await waitFor(() => expect(screen.getByTestId('events-empty')).toBeInTheDocument());
});

test('Signals sub-view: nav mounts the probe plotter with real topic/field controls', async () => {
  mockFetch();
  renderWithClient(<MonitorScreen />);
  await screen.findByTestId('mon-nav-Signals');

  fireEvent.click(screen.getByTestId('mon-nav-Signals'));
  expect(screen.getByTestId('signals-topic')).toBeInTheDocument();
  expect(screen.getByTestId('signals-add')).toBeInTheDocument();
  expect(screen.getByTestId('signals-empty')).toBeInTheDocument();
});

test('Rec column: seeds the recording set from the configured topics on discovery', async () => {
  mockFetch();
  renderWithClient(<MonitorScreen />);
  await gotoTopics();

  await waitFor(() => expect(screen.getByTestId('rec-check-/hsrb/joint_states')).toBeChecked());
  expect(screen.getByTestId('rec-check-/hsrb/odom')).not.toBeChecked();
  expect([...useUiStore.getState().recordSelected]).toContain('/hsrb/joint_states');
});

test('Rec column: toggling a checkbox customizes the set and it survives a sub-view round-trip', async () => {
  mockFetch();
  renderWithClient(<MonitorScreen />);
  await gotoTopics();
  await waitFor(() => expect(screen.getByTestId('rec-check-/hsrb/odom')).toBeInTheDocument());

  fireEvent.click(screen.getByTestId('rec-check-/hsrb/odom'));
  await waitFor(() => expect(useUiStore.getState().recordCustomized).toBe(true));
  expect([...useUiStore.getState().recordSelected]).toContain('/hsrb/odom');

  fireEvent.click(screen.getByTestId('mon-nav-Signals'));
  fireEvent.click(screen.getByTestId('mon-nav-Topics'));
  await waitFor(() => expect(screen.getByTestId('rec-check-/hsrb/odom')).toBeChecked());
  expect(useUiStore.getState().recordCustomized).toBe(true);
});

test('Topics empty-state: no topics discovered explains why instead of an empty chart', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/config')) return Promise.resolve(jsonResponse(CONFIG));
    if (url.includes('/topics')) return Promise.resolve(jsonResponse([]));
    return Promise.resolve(jsonResponse({}));
  });
  renderWithClient(<MonitorScreen />);
  await gotoTopics();

  await waitFor(() => expect(screen.getByTestId('topics-table-empty')).toBeInTheDocument());
  expect(
    screen.getByText(
      'No topic to chart yet — pick one from the table below once topics are discovered.',
    ),
  ).toBeInTheDocument();
});
