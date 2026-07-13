import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { useUiStore } from '../../store/uiStore';
import { MonitorScreen } from './MonitorScreen';

const CONFIG = {
  endpoints: { api: '/api/v1', events: '/api/v1/events', webrtc: 'http://localhost:8002' },
  tabs: [],
  defaults: {
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

beforeEach(() => {
  setApiBase('/api/v1');
  useUiStore.setState({
    activeTab: 'monitor',
    sseStatus: 'closed',
    monitorBridge: null,
    recMarkers: [],
    recMarkersPrevActive: null,
    probeSeries: [],
  });
});
afterEach(() => vi.restoreAllMocks());

test('lands on Topics: chart defaults to the first discovered topic, table lists both', async () => {
  mockFetch();
  renderWithClient(<MonitorScreen />);

  await waitFor(() => expect(screen.getByTestId('topic-row-/hsrb/joint_states')).toBeInTheDocument());
  expect(screen.getByTestId('topic-row-/hsrb/odom')).toBeInTheDocument();
  // Configured topic sorts first (useMonitorRows) and is the chart's default —
  // it's charted (aria-pressed) and appears in the chart's per-series legend.
  expect(screen.getByTestId('topic-row-/hsrb/joint_states')).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByTestId('freq-legend-/hsrb/joint_states')).toBeInTheDocument();
});

test('clicking a second topic overlays it (both charted); clicking again removes it', async () => {
  mockFetch();
  renderWithClient(<MonitorScreen />);

  await waitFor(() => expect(screen.getByTestId('topic-row-/hsrb/odom')).toBeInTheDocument());
  // odom starts un-charted; the default (joint_states) is already charted.
  expect(screen.getByTestId('topic-row-/hsrb/odom')).toHaveAttribute('aria-pressed', 'false');

  fireEvent.click(screen.getByTestId('topic-row-/hsrb/odom'));
  // Now BOTH overlay the chart — the overlay the user asked for.
  await waitFor(() =>
    expect(screen.getByTestId('topic-row-/hsrb/odom')).toHaveAttribute('aria-pressed', 'true'),
  );
  expect(screen.getByTestId('topic-row-/hsrb/joint_states')).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByTestId('freq-legend-/hsrb/odom')).toBeInTheDocument();
  expect(screen.getByTestId('freq-legend-/hsrb/joint_states')).toBeInTheDocument();

  // Toggling it off drops it back out of the charted set.
  fireEvent.click(screen.getByTestId('topic-row-/hsrb/odom'));
  await waitFor(() =>
    expect(screen.getByTestId('topic-row-/hsrb/odom')).toHaveAttribute('aria-pressed', 'false'),
  );
  expect(screen.queryByTestId('freq-legend-/hsrb/odom')).not.toBeInTheDocument();
});

test('sub-nav: switching away from Topics shows the placeholder, and back returns', async () => {
  mockFetch();
  renderWithClient(<MonitorScreen />);
  await screen.findByTestId('mon-nav-Topics');

  fireEvent.click(screen.getByTestId('mon-nav-System'));
  expect(screen.getByText(/specified in §11/)).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Back to Topics' }));
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
  // The fabricated "Episode #27 / FROM COLLECT WARNING" mock is gone.
  expect(screen.queryByText(/Episode #27/)).not.toBeInTheDocument();
  expect(screen.queryByText(/FROM COLLECT WARNING/)).not.toBeInTheDocument();
});

test('context strip: REC + run_id shown while a real recording is running', async () => {
  mockFetch({ state: 'recording', run_id: 'run_test', started_at: '2026-07-13T15:00:00Z' });
  renderWithClient(<MonitorScreen />);

  await waitFor(() => expect(screen.getByTestId('context-state')).toHaveTextContent('REC'));
  expect(screen.getByTestId('monitor-context')).toHaveTextContent('run_test');
});

test('Events card: honest empty state when the alert buffer is empty', async () => {
  mockFetch();
  renderWithClient(<MonitorScreen />);
  await waitFor(() => expect(screen.getByTestId('events-empty')).toBeInTheDocument());
});

test('Signals sub-view: nav mounts the probe plotter with real topic/field controls', async () => {
  mockFetch();
  renderWithClient(<MonitorScreen />);
  await screen.findByTestId('mon-nav-Signals');

  fireEvent.click(screen.getByTestId('mon-nav-Signals'));
  // Real probe controls (topic dropdown + add button) and the honest no-series state.
  expect(screen.getByTestId('signals-topic')).toBeInTheDocument();
  expect(screen.getByTestId('signals-add')).toBeInTheDocument();
  expect(screen.getByTestId('signals-empty')).toBeInTheDocument();
});

test('empty-state: no topics discovered explains why instead of an empty chart only', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/config')) return Promise.resolve(jsonResponse(CONFIG));
    if (url.includes('/topics')) return Promise.resolve(jsonResponse([]));
    return Promise.resolve(jsonResponse({}));
  });
  renderWithClient(<MonitorScreen />);

  await waitFor(() => expect(screen.getByTestId('topics-table-empty')).toBeInTheDocument());
  expect(screen.getByText('No topic to chart yet — pick one from the table below once topics are discovered.')).toBeInTheDocument();
});
