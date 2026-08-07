// Multi-panel behaviour for the Monitor Topics view (v1 Graph tab add/remove
// parity): the "+ Add chart" affordance, per-panel topic-set independence, the
// primary panel's table-click binding, non-primary Remove, and the GLOBAL
// (single-instance) window + pause controls. Renders the real MonitorScreen so
// the module panel store, TopicsView, and FrequencyChartCard are exercised
// together. The panel store is module-level, so reset it between tests.

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
    if (url.includes('/record/status')) {
      // An idle recorder answers with an empty live list, never without one (§10).
      return Promise.resolve(
        jsonResponse({ state: 'created', run_id: null, live_capture_ids: [] }),
      );
    }
    if (url.includes('/topics')) return Promise.resolve(jsonResponse(DISCOVERED));
    if (url.includes('/system')) {
      return Promise.resolve(jsonResponse({ cpu: { model: 'Test CPU', cores: 8 }, gpu: null }));
    }
    return Promise.resolve(jsonResponse({}));
  });
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

test('+ Add chart adds a second panel defaulting to a distinct metric (Hz → Bandwidth)', async () => {
  mockFetch();
  renderWithClient(<MonitorScreen />);
  // Default sub-view is Overview (§11 landing); drill into Topics for the charts.
  fireEvent.click(await screen.findByTestId('mon-nav-Topics'));
  await waitFor(() => expect(screen.getByTestId('topic-row-/hsrb/odom')).toBeInTheDocument());

  // Only the primary panel to start: its metric select has no id suffix.
  expect(screen.getByTestId('freq-metric-select')).toBeInTheDocument();
  expect(screen.queryByTestId('freq-metric-select-1')).not.toBeInTheDocument();

  fireEvent.click(screen.getByTestId('add-chart'));

  // A second panel appears with its own (suffixed) controls, defaulting to the
  // first metric the primary isn't already showing — Bandwidth.
  await waitFor(() => expect(screen.getByTestId('freq-metric-select-1')).toBeInTheDocument());
  expect(screen.getByTestId('freq-metric-select')).toHaveValue('hz');
  expect(screen.getByTestId('freq-metric-select-1')).toHaveValue('bw');
});

test('per-panel topic sets are independent (add/remove on panel 2 never touches panel 1)', async () => {
  mockFetch();
  renderWithClient(<MonitorScreen />);
  // Default sub-view is Overview (§11 landing); drill into Topics for the charts.
  fireEvent.click(await screen.findByTestId('mon-nav-Topics'));
  await waitFor(() => expect(screen.getByTestId('topic-row-/hsrb/odom')).toBeInTheDocument());

  // Primary charts the configured default (joint_states) and nothing else.
  expect(screen.getByTestId('freq-legend-/hsrb/joint_states')).toBeInTheDocument();
  expect(screen.queryByTestId('freq-legend-/hsrb/odom')).not.toBeInTheDocument();

  // Add a panel (seeded with the first topic) and overlay odom onto it via ITS
  // own add-topic control.
  fireEvent.click(screen.getByTestId('add-chart'));
  await waitFor(() => expect(screen.getByTestId('freq-add-topic-1')).toBeInTheDocument());
  fireEvent.change(screen.getByTestId('freq-add-topic-1'), { target: { value: '/hsrb/odom' } });

  await waitFor(() =>
    expect(screen.getByTestId('freq-legend-1-/hsrb/odom')).toBeInTheDocument(),
  );
  // Panel 2 now overlays BOTH; panel 1 is unchanged (still just joint_states).
  expect(screen.getByTestId('freq-legend-1-/hsrb/joint_states')).toBeInTheDocument();
  expect(screen.queryByTestId('freq-legend-/hsrb/odom')).not.toBeInTheDocument();

  // Remove joint_states from panel 2 only — panel 1 keeps it.
  fireEvent.click(screen.getByTestId('freq-chip-remove-1-/hsrb/joint_states'));
  await waitFor(() =>
    expect(screen.queryByTestId('freq-legend-1-/hsrb/joint_states')).not.toBeInTheDocument(),
  );
  expect(screen.getByTestId('freq-legend-1-/hsrb/odom')).toBeInTheDocument();
  expect(screen.getByTestId('freq-legend-/hsrb/joint_states')).toBeInTheDocument();
});

test('the topics table row-click toggles PANEL 1 only, never other panels', async () => {
  mockFetch();
  renderWithClient(<MonitorScreen />);
  // Default sub-view is Overview (§11 landing); drill into Topics for the charts.
  fireEvent.click(await screen.findByTestId('mon-nav-Topics'));
  await waitFor(() => expect(screen.getByTestId('topic-row-/hsrb/odom')).toBeInTheDocument());

  fireEvent.click(screen.getByTestId('add-chart'));
  await waitFor(() => expect(screen.getByTestId('freq-metric-select-1')).toBeInTheDocument());

  // Clicking a row overlays it on the PRIMARY panel (v1 Graph parity).
  fireEvent.click(screen.getByTestId('topic-row-/hsrb/odom'));
  await waitFor(() => expect(screen.getByTestId('freq-legend-/hsrb/odom')).toBeInTheDocument());
  // Panel 2 was seeded with joint_states and is untouched by the table click.
  expect(screen.queryByTestId('freq-legend-1-/hsrb/odom')).not.toBeInTheDocument();
  expect(screen.getByTestId('freq-legend-1-/hsrb/joint_states')).toBeInTheDocument();
});

test('primary panel has no Remove; non-primary panels can be removed', async () => {
  mockFetch();
  renderWithClient(<MonitorScreen />);
  // Default sub-view is Overview (§11 landing); drill into Topics for the charts.
  fireEvent.click(await screen.findByTestId('mon-nav-Topics'));
  await waitFor(() => expect(screen.getByTestId('topic-row-/hsrb/odom')).toBeInTheDocument());

  // The lone primary panel offers no Remove control.
  expect(screen.queryByTestId('freq-remove')).not.toBeInTheDocument();

  fireEvent.click(screen.getByTestId('add-chart'));
  await waitFor(() => expect(screen.getByTestId('freq-remove-1')).toBeInTheDocument());
  // Still no Remove on the primary.
  expect(screen.queryByTestId('freq-remove')).not.toBeInTheDocument();

  fireEvent.click(screen.getByTestId('freq-remove-1'));
  await waitFor(() => expect(screen.queryByTestId('freq-metric-select-1')).not.toBeInTheDocument());
});

test('window + pause are a single GLOBAL control regardless of panel count', async () => {
  mockFetch();
  renderWithClient(<MonitorScreen />);
  // Default sub-view is Overview (§11 landing); drill into Topics for the charts.
  fireEvent.click(await screen.findByTestId('mon-nav-Topics'));
  await waitFor(() => expect(screen.getByTestId('topic-row-/hsrb/odom')).toBeInTheDocument());

  fireEvent.click(screen.getByTestId('add-chart'));
  fireEvent.click(screen.getByTestId('add-chart'));
  await waitFor(() => expect(screen.getByTestId('freq-metric-select-2')).toBeInTheDocument());

  // Three panels, but exactly ONE pause and ONE window group (lifted to the toolbar).
  expect(screen.getAllByTestId('freq-pause')).toHaveLength(1);
  expect(screen.getAllByTestId('freq-window-1m')).toHaveLength(1);

  const pause = screen.getByTestId('freq-pause');
  expect(pause).toHaveTextContent('Freeze charts');
  fireEvent.click(pause);
  expect(pause).toHaveTextContent('Live');
  // Freezing charts scopes only the charts — the table stays live (D-7-3).
  expect(screen.getByTestId('freeze-note')).toHaveTextContent('Charts frozen · table still live.');
});

test('+ Add chart is disabled once the panel cap (4) is reached', async () => {
  mockFetch();
  renderWithClient(<MonitorScreen />);
  // Default sub-view is Overview (§11 landing); drill into Topics for the charts.
  fireEvent.click(await screen.findByTestId('mon-nav-Topics'));
  await waitFor(() => expect(screen.getByTestId('topic-row-/hsrb/odom')).toBeInTheDocument());

  const add = screen.getByTestId('add-chart');
  fireEvent.click(add); // 2
  fireEvent.click(add); // 3
  fireEvent.click(add); // 4 (cap)
  await waitFor(() => expect(screen.getByTestId('freq-metric-select-3')).toBeInTheDocument());
  expect(add).toBeDisabled();
});

test('panel configs survive a Monitor sub-nav round-trip (module store)', async () => {
  mockFetch();
  renderWithClient(<MonitorScreen />);
  // Default sub-view is Overview (§11 landing); drill into Topics for the charts.
  fireEvent.click(await screen.findByTestId('mon-nav-Topics'));
  await waitFor(() => expect(screen.getByTestId('topic-row-/hsrb/odom')).toBeInTheDocument());

  fireEvent.click(screen.getByTestId('add-chart'));
  await waitFor(() => expect(screen.getByTestId('freq-metric-select-1')).toBeInTheDocument());

  // Leave Topics for another sub-view and return — the second panel persists
  // because its config lives in the module store, not the unmounted view.
  fireEvent.click(screen.getByTestId('mon-nav-Signals'));
  await waitFor(() => expect(screen.queryByTestId('freq-metric-select-1')).not.toBeInTheDocument());
  fireEvent.click(screen.getByTestId('mon-nav-Topics'));
  await waitFor(() => expect(screen.getByTestId('freq-metric-select-1')).toBeInTheDocument());
});
