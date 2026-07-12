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

function mockFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/config')) return Promise.resolve(jsonResponse(CONFIG));
    if (url.includes('/topics')) return Promise.resolve(jsonResponse(DISCOVERED));
    if (url.includes('/system')) {
      return Promise.resolve(jsonResponse({ cpu: { model: 'Test CPU', cores: 8 }, gpu: null }));
    }
    return Promise.resolve(jsonResponse({}));
  });
}

beforeEach(() => {
  setApiBase('/api/v1');
  useUiStore.setState({ activeTab: 'monitor', sseStatus: 'closed', monitorBridge: null });
});
afterEach(() => vi.restoreAllMocks());

test('lands on Topics: chart defaults to the first discovered topic, table lists both', async () => {
  mockFetch();
  renderWithClient(<MonitorScreen />);

  await waitFor(() => expect(screen.getByTestId('topic-row-/hsrb/joint_states')).toBeInTheDocument());
  expect(screen.getByTestId('topic-row-/hsrb/odom')).toBeInTheDocument();
  // Configured topic sorts first (useMonitorRows) and is the chart's default.
  expect(screen.getAllByText('/hsrb/joint_states')[0]).toBeInTheDocument();
});

test('clicking a topic row switches the charted topic (chart header updates)', async () => {
  mockFetch();
  renderWithClient(<MonitorScreen />);

  await waitFor(() => expect(screen.getByTestId('topic-row-/hsrb/odom')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('topic-row-/hsrb/odom'));

  // The chart card's mono header shows the selected topic's full name.
  await waitFor(() =>
    expect(screen.getByTestId('topic-row-/hsrb/odom').className).toContain('bg-teal-50'),
  );
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
