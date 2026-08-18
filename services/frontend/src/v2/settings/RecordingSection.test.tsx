// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
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

// What GET /config/recording currently serves; flipped to simulate another
// terminal (or a robot switch) rewriting the file under an open editor.
let serverRecording: typeof RECORDING = RECORDING;

const RECORDING_CHANGED = {
  ...RECORDING,
  config: {
    ...RECORDING.config,
    default_topics: [...RECORDING.config.default_topics, '/hsrb/odom'],
    recording: { start_paused: true, compression: 'none', max_cache_size_mb: 512 },
  },
};

function mockFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/config/recording')) return Promise.resolve(jsonResponse(serverRecording));
    return Promise.resolve(jsonResponse({}));
  });
}

beforeEach(() => {
  setApiBase('/api/v1');
  serverRecording = RECORDING;
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

// ---------------------------------------------------------------------------
// A REFETCH landing on a dirty JSON buffer — the recording half of the same
// scenario as AlertsCard. Reached the same way: `event: resync` after a
// reconnect makes the client call a keyless `qc.invalidateQueries()`
// (sse/useEventStream.ts), and RECORDING_CONFIG_KEY is additionally invalidated
// by RobotsSection, ValidationSection and Collect's ContextBar.
// ---------------------------------------------------------------------------

/** Open Settings > Recording > Advanced and return the seeded JSON editor. */
async function openAdvancedEditor() {
  await screen.findByTestId('recording-advanced-toggle');
  fireEvent.click(screen.getByTestId('recording-advanced-toggle'));
  const editor = (await screen.findByLabelText('recording config json')) as HTMLTextAreaElement;
  await waitFor(() => expect(editor.value).toContain('"robot_name": "airoa_hsr"'));
  return editor;
}

/** The reconnect refetch, awaited until the component has RE-RENDERED with the
 *  new payload. The topic count is read straight from the query, not from the
 *  editor buffer, so it moves whether or not the buffer was clobbered — without
 *  that probe a "the buffer survived" assertion passes vacuously, because the
 *  cache updates inside act() a tick before the observer re-renders. */
async function resyncRefetch(client: { invalidateQueries: () => Promise<void> }) {
  await act(async () => {
    await client.invalidateQueries();
  });
  await waitFor(() =>
    expect(screen.getByTestId('recording-topic-count')).toHaveTextContent('3 topics'),
  );
}

test('a reconnect refetch does not silently discard unsaved JSON edits', async () => {
  const { client } = renderWithClient(<RecordingSection config={CONFIG} />);
  const editor = await openAdvancedEditor();

  const mine = '{\n  "robot_name": "airoa_hsr",\n  "default_topics": ["/my/unsaved/topic"]\n}';
  fireEvent.change(editor, { target: { value: mine } });

  serverRecording = RECORDING_CHANGED;
  await resyncRefetch(client);

  expect((screen.getByLabelText('recording config json') as HTMLTextAreaElement).value).toBe(mine);
  expect(screen.getByTestId('recording-server-changed')).toBeInTheDocument();
});

test('a CLEAN JSON buffer still adopts the refetched config', async () => {
  const { client } = renderWithClient(<RecordingSection config={CONFIG} />);
  await openAdvancedEditor();

  serverRecording = RECORDING_CHANGED;
  await resyncRefetch(client);

  const editor = screen.getByLabelText('recording config json') as HTMLTextAreaElement;
  expect(editor.value).toContain('/hsrb/odom');
  expect(editor.value).toContain('"compression": "none"');
  expect(screen.queryByTestId('recording-server-changed')).not.toBeInTheDocument();
});

test('the operator can take the server copy of the recording config', async () => {
  const { client } = renderWithClient(<RecordingSection config={CONFIG} />);
  const editor = await openAdvancedEditor();
  fireEvent.change(editor, { target: { value: '{"robot_name": "mine"}' } });

  serverRecording = RECORDING_CHANGED;
  await resyncRefetch(client);
  fireEvent.click(screen.getByTestId('recording-load-server'));

  const after = screen.getByLabelText('recording config json') as HTMLTextAreaElement;
  expect(after.value).toContain('/hsrb/odom');
  expect(screen.queryByTestId('recording-server-changed')).not.toBeInTheDocument();
});
