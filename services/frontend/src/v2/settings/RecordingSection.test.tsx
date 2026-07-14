import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import type { RuntimeConfig } from '../../config';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { RecordingSection } from './RecordingSection';

const CONFIG = {
  endpoints: { api: '/api/v1', events: '/api/v1/events', webrtc: 'http://localhost:8002' },
  tabs: [],
  defaults: { robot_name: 'airoa_hsr', default_topics: ['/hsrb/joint_states'] },
  schemas: {},
} as unknown as RuntimeConfig;

const RECORDING = {
  path: '/config/airoa_hsr/recording/default.yaml',
  config: {
    robot_name: 'airoa_hsr',
    default_topics: ['/hsrb/joint_states', '/hsrb/head_rgbd_sensor/rgb/image_rect_color/compressed'],
    expected_hz_patterns: [
      { pattern: '/hsrb/joint_states', hz: 25 },
      { pattern: '/hsrb/head_rgbd_sensor/*', hz: 30 },
    ],
    topic_qos_overrides: [
      { pattern: '/hsrb/head_rgbd_sensor/*', reliability: 'best_effort', durability: 'volatile', depth: 5 },
    ],
    recording: { start_paused: true, compression: 'zstd', max_cache_size_mb: 512 },
  },
};

function mockFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/config/recording')) return Promise.resolve(jsonResponse(RECORDING));
    return Promise.resolve(jsonResponse({}));
  });
}

beforeEach(() => {
  setApiBase('/api/v1');
  mockFetch();
});
afterEach(() => vi.restoreAllMocks());

test('form-first: shows compression / start gate / cache and the default_topics table', async () => {
  renderWithClient(<RecordingSection config={CONFIG} />);

  // Wait for the config to load (the header renders during loading too).
  await screen.findByTestId('recording-topics');
  expect(screen.getByTestId('recording-robot')).toHaveTextContent('airoa_hsr');
  expect(screen.getByText('zstd')).toBeInTheDocument();
  expect(screen.getByText('start-paused armed')).toBeInTheDocument();
  expect(screen.getByText('512 MiB')).toBeInTheDocument();
  expect(screen.getByTestId('recording-topic-count')).toHaveTextContent('2 topics');

  // joint_states row: expected 25 Hz, default QoS.
  const js = screen.getByTestId('recording-topic-/hsrb/joint_states');
  expect(js).toHaveTextContent('25 Hz');
  expect(js).toHaveTextContent('default');
  // camera row: expected 30 Hz + a custom QoS override.
  const cam = screen.getByTestId(
    'recording-topic-/hsrb/head_rgbd_sensor/rgb/image_rect_color/compressed',
  );
  expect(cam).toHaveTextContent('30 Hz');
  expect(cam).toHaveTextContent('custom');
});

test('the raw JSON editor is demoted to a collapsed Advanced disclosure', async () => {
  renderWithClient(<RecordingSection config={CONFIG} />);
  await screen.findByTestId('recording-advanced-toggle');

  // Collapsed by default — no JSON textarea visible.
  expect(screen.queryByLabelText('recording config json')).not.toBeInTheDocument();

  fireEvent.click(screen.getByTestId('recording-advanced-toggle'));
  const editor = (await screen.findByLabelText('recording config json')) as HTMLTextAreaElement;
  await waitFor(() => expect(editor.value).toContain('"robot_name": "airoa_hsr"'));
});
