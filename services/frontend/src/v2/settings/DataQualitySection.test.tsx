import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import type { RuntimeConfig } from '../../config';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { DataQualitySection } from './DataQualitySection';

const CONFIG = {
  endpoints: { api: '/api/v1', events: '/api/v1/events', webrtc: 'http://localhost:8002' },
  tabs: [],
  // robot_name (friendly) deliberately differs from the robot directory id
  // (active_robot 'airoa_hsr') — the alerts.yaml path must use the directory id.
  defaults: { robot_name: 'hsr' },
  schemas: {},
} as unknown as RuntimeConfig;

const OPTIONS = { active_robot: 'airoa_hsr', robots: [{ id: 'airoa_hsr', local: false }], aspects: {} };

// GET /api/v1/config/robots/airoa_hsr — RobotConfig with parsed aspect content.
const ROBOT = {
  robot: 'airoa_hsr',
  local: false,
  active: true,
  summary: { robot_name: 'hsr', default_topics: [] },
  aspects: {
    recording: {
      id: 'default',
      path: '/config/airoa_hsr/recording/default.yaml',
      local: false,
      content: {
        expected_hz_patterns: [{ pattern: '/hsrb/joint_states', hz: 25 }],
        monitor: { warn_shortfall: 0.02, danger_shortfall: 0.05 },
      },
    },
    stream: null,
    validation: {
      id: 'default',
      path: '/config/airoa_hsr/validation/default.yaml',
      local: false,
      content: {
        name: 'airoa_hsr',
        version: 1,
        required_topics: [{ name: '/hsrb/joint_states', type: 'sensor_msgs/msg/JointState' }],
      },
    },
    validators: null,
  },
};

// The two per-robot editor aspects the section now hosts (AlertsCard / SignalsCard).
const ALERTS = {
  path: '/config/airoa_hsr/monitoring/alerts.yaml',
  raw: 'rules: []\n',
  warnings: [],
  config: { rules: [{ topic: '/hsrb/joint_states', metric: 'hz', op: 'lt', threshold: 15 }] },
};
const SIGNALS = {
  path: '/config/airoa_hsr/signals/default.yaml',
  raw: 'fallback_fields: 4\n',
  config: { hidden_field_patterns: ['header.*'], default_topic: '/hsrb/joint_states', defaults: [], fallback_fields: 4 },
};

function mockFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/config/robots/')) return Promise.resolve(jsonResponse(ROBOT));
    if (url.includes('/config/options')) return Promise.resolve(jsonResponse(OPTIONS));
    if (url.includes('/config/alerts')) return Promise.resolve(jsonResponse(ALERTS));
    if (url.includes('/config/signals')) return Promise.resolve(jsonResponse(SIGNALS));
    return Promise.resolve(jsonResponse({}));
  });
}

beforeEach(() => {
  setApiBase('/api/v1');
  mockFetch();
});
afterEach(() => vi.restoreAllMocks());

test('shows real expected rates, threshold convention, and required topics from RobotConfig', async () => {
  renderWithClient(<DataQualitySection config={CONFIG} />);

  await waitFor(() => expect(screen.getByTestId('dq-expected-hz')).toHaveTextContent('/hsrb/joint_states'));
  expect(screen.getByTestId('dq-expected-hz')).toHaveTextContent('25 Hz');
  // Threshold convention from the real monitor config (2% / 5%).
  expect(screen.getByTestId('dq-thresholds')).toHaveTextContent('2%');
  expect(screen.getByTestId('dq-thresholds')).toHaveTextContent('5%');
  // Active validation template's required topics.
  expect(screen.getByTestId('dq-required-topics')).toHaveTextContent('/hsrb/joint_states');
});

test('hosts the alert-rules and signals editors (the old "not exposed" note is gone)', async () => {
  renderWithClient(<DataQualitySection config={CONFIG} />);

  // The alert rules are now an editable surface (from GET /config/alerts), not a
  // note pointing at a file — the seeded rule's topic renders in the table.
  await waitFor(() =>
    expect(screen.getByTestId('settings-alerts')).toHaveTextContent('applies on monitor restart'),
  );
  expect((await screen.findByLabelText('rule topic 0')) as HTMLInputElement).toHaveValue(
    '/hsrb/joint_states',
  );
  // The Signals defaults editor is present too.
  expect(screen.getByTestId('settings-signals')).toBeInTheDocument();
  // The removed note must be gone.
  expect(screen.queryByTestId('dq-alerts-note')).not.toBeInTheDocument();
  expect(screen.queryByText(/not exposed by the API/)).not.toBeInTheDocument();
});
