// E-22 at the CALL SITES.
//
// `seedKey.test.ts` proves `configSeedKey` is order-insensitive and that the
// uiStore keeps a customised selection when the key is unchanged. That is the
// module. It says nothing about whether the product still CALLS it — revert
// either call site to `JSON.stringify(list)` and every one of those tests stays
// green, because a unit test of a helper cannot notice that someone stopped
// using the helper.
//
// So these two tests sit where the defect lives: render the real component,
// let the operator customise, then re-render with the SAME configured set in a
// DIFFERENT order — a pure reorder, no member added or removed — and assert the
// operator's work survives. Each must go red against `JSON.stringify` at its
// own site.

import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { setApiBase } from '../api/client';
import { jsonResponse, makeTestClient } from '../test/renderWithClient';
import type { RuntimeConfig } from '../config';
import { useUiStore } from '../store/uiStore';
import { Cameras } from './collect/Cameras';
import {
  __resetCameraStore,
  addCameraPane,
  getCameraState,
} from './collect/cameraStore';
import { TopicsView } from './monitor/TopicsView';
import type { BatchMachine } from './collect/useBatchMachine';

const HEAD = '/hsrb/head_rgbd_sensor/rgb/image_rect_color/compressed';
const HAND = '/hsrb/hand_camera/image_raw/compressed';
const OPERATOR_PANE = '/hsrb/operator/added/image_raw/compressed';

const TF = '/tf';
const JOINTS = '/joint_states';

/** RuntimeConfig with the configured camera panes in a given order. */
function configWithPanes(panes: string[]): RuntimeConfig {
  return {
    endpoints: { api: '/api/v1', events: '/api/v1/events', webrtc: 'http://localhost:8002' },
    tabs: [],
    defaults: { default_topics: [HEAD, HAND] },
    stream: { columns: 2, panes: panes.map((topic) => ({ topic })) },
    schemas: {},
  } as unknown as RuntimeConfig;
}

/** RuntimeConfig with default_topics in a given order. */
function configWithTopics(topics: string[]): RuntimeConfig {
  return {
    endpoints: { api: '/api/v1', events: '/api/v1/events', webrtc: 'http://localhost:8002' },
    tabs: [],
    defaults: { default_topics: topics },
    schemas: {},
  } as unknown as RuntimeConfig;
}

const MACHINE = { phase: 'ready', elapsedMs: 0 } as unknown as BatchMachine;

// Cameras opens a WebRTC preview per pane; jsdom has no RTCPeerConnection and
// the panes only need to EXIST for this test, not to stream.
class InertPeerConnection {
  connectionState = 'new';
  iceGatheringState = 'complete';
  localDescription = null;
  addEventListener() {}
  removeEventListener() {}
  addTransceiver() {}
  async createOffer() {
    return { type: 'offer', sdp: 'v=0' };
  }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  getReceivers() {
    return [];
  }
  getSenders() {
    return [];
  }
  getStats() {
    return Promise.resolve(new Map());
  }
  close() {}
}

beforeEach(() => {
  setApiBase('/api/v1');
  __resetCameraStore();
  useUiStore.setState({
    recordSelected: new Set<string>(),
    recordCustomized: false,
    recordSeededKey: null,
  });
  vi.stubGlobal('RTCPeerConnection', InertPeerConnection);
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/topics')) {
      return Promise.resolve(
        jsonResponse([
          { name: TF, type: 'tf2_msgs/msg/TFMessage' },
          { name: JOINTS, type: 'sensor_msgs/msg/JointState' },
        ]),
      );
    }
    return Promise.resolve(jsonResponse({}));
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('Cameras: reordering the configured cameras keeps an operator-opened pane', async () => {
  const client = makeTestClient();
  const wrap = (config: RuntimeConfig) => (
    <QueryClientProvider client={client}>
      <Cameras config={config} machine={MACHINE} />
    </QueryClientProvider>
  );

  const { rerender } = render(wrap(configWithPanes([HEAD, HAND])));
  await waitFor(() => expect(getCameraState().panes.length).toBe(2));

  // The operator opens a camera of their own.
  addCameraPane(OPERATOR_PANE);
  expect(getCameraState().panes.map((p) => p.topic)).toContain(OPERATOR_PANE);

  // Someone reorders config.stream.panes. Same two cameras, different order —
  // no camera added, none removed, nothing about this robot has changed.
  rerender(wrap(configWithPanes([HAND, HEAD])));

  // The operator's pane must still be there: a reorder is not a robot switch.
  await waitFor(() => expect(getCameraState().panes.length).toBeGreaterThan(2));
  expect(getCameraState().panes.map((p) => p.topic)).toContain(OPERATOR_PANE);
});

test('TopicsView: reordering default_topics keeps the operator Rec selection', async () => {
  const client = makeTestClient();
  const wrap = (config: RuntimeConfig) => (
    <QueryClientProvider client={client}>
      <TopicsView config={config} />
    </QueryClientProvider>
  );

  const { rerender } = render(wrap(configWithTopics([TF, JOINTS])));
  // Wait for discovery to arrive and the selection to be seeded from it.
  await waitFor(() => expect(useUiStore.getState().recordSeededKey).not.toBeNull());
  await screen.findByText(TF);

  // The operator customises: drop one configured topic from the next recording.
  useUiStore.getState().toggleRecordTopic(TF);
  expect(useUiStore.getState().recordCustomized).toBe(true);
  expect(useUiStore.getState().recordSelected.has(TF)).toBe(false);

  // Someone reorders default_topics in Settings > Recording. Same set.
  rerender(wrap(configWithTopics([JOINTS, TF])));

  // Re-seeding here would silently put /tf back into the next recording — the
  // list still showing everything the operator wanted, while what actually gets
  // recorded is not what they chose.
  await waitFor(() => expect(useUiStore.getState().recordSelected.has(JOINTS)).toBe(true));
  expect(useUiStore.getState().recordSelected.has(TF)).toBe(false);
  expect(useUiStore.getState().recordCustomized).toBe(true);
});
