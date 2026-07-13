import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import type { RuntimeConfig } from '../../config';
import type { BatchMachine } from './useBatchMachine';
import { Cameras, StatsBadge, shortCameraLabel } from './Cameras';
import {
  MAX_CAMERA_PANES,
  __resetCameraStore,
  addCameraPane,
  getCameraState,
  imageTopicOptions,
  removeCameraPane,
  seedCameraPanes,
  setMainCameraPane,
} from './cameraStore';

const HEAD = '/hsrb/head_rgbd_sensor/rgb/image_rect_color/compressed';
const HAND = '/hsrb/hand_camera/image_raw/compressed';

const CONFIG: RuntimeConfig = {
  endpoints: { api: '/api/v1', events: '/api/v1/events', webrtc: 'http://localhost:8002' },
  tabs: [],
  defaults: { default_topics: [HEAD, HAND] },
  stream: {
    columns: 2,
    panes: [{ topic: HEAD }, { topic: HAND }],
  },
  schemas: {},
};

// Only the fields Cameras actually reads.
const MACHINE = { phase: 'ready', elapsedMs: 0 } as unknown as BatchMachine;

// Minimal RTCPeerConnection stub that drives the negotiation to "connected"
// (same pattern as StreamTab.test.tsx).
class FakePeerConnection {
  connectionState = 'new';
  iceGatheringState = 'complete';
  localDescription: { type: string; sdp: string } | null = null;
  private listeners: Record<string, ((ev?: unknown) => void)[]> = {};
  addEventListener(type: string, cb: (ev?: unknown) => void) {
    (this.listeners[type] ??= []).push(cb);
  }
  removeEventListener() {}
  addTransceiver() {}
  async createOffer() {
    return { type: 'offer', sdp: 'v=0 offer' };
  }
  async setLocalDescription(desc: { type: string; sdp: string }) {
    this.localDescription = desc;
  }
  async setRemoteDescription() {
    this.connectionState = 'connected';
    this.listeners['connectionstatechange']?.forEach((cb) => cb());
  }
  getSenders() {
    return [];
  }
  close() {}
  getStats() {
    return Promise.resolve(new Map());
  }
}

beforeEach(() => {
  setApiBase('/api/v1');
  // The camera panes live in a module-level store (survives tab-switch
  // unmounts); reset it so one test's panes/main/res can't leak into the next.
  __resetCameraStore();
  vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/stream/start')) return Promise.resolve(jsonResponse({ stream_id: 's-1' }));
    if (url.includes('/stream/offer'))
      return Promise.resolve(jsonResponse({ type: 'answer', sdp: 'v=0 answer' }));
    if (url.includes('/topics')) return Promise.resolve(jsonResponse([]));
    return Promise.resolve(jsonResponse({}));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('shortCameraLabel derives a human name from real robot topics', () => {
  expect(shortCameraLabel(HEAD)).toBe('head');
  expect(shortCameraLabel(HAND)).toBe('hand');
});

// ---------------------------------------------------------------------------
// StatsBadge: the v1-style top-right latency/fps chip.
// ---------------------------------------------------------------------------

const stats = (fps: number | null, latencyMs: number | null) => ({
  fps,
  latencyMs,
  width: null,
  height: null,
});

test('StatsBadge renders measured latency (threshold colour) and fps', () => {
  const { rerender } = render(<StatsBadge stats={stats(24, 200)} />);
  // High latency -> red (v1 thresholds: >150 red, >=85 amber, else teal).
  expect(screen.getByText('200ms')).toHaveStyle({ color: '#dc2626' });
  expect(screen.getByText('24fps')).toBeInTheDocument();

  rerender(<StatsBadge stats={stats(24, 90)} />);
  expect(screen.getByText('90ms')).toHaveStyle({ color: '#d97706' });
  rerender(<StatsBadge stats={stats(24, 40)} />);
  expect(screen.getByText('40ms')).toHaveStyle({ color: '#0d9488' });
});

test('StatsBadge shows only measured values and nothing when none exist', () => {
  // fps alone (latency not yet measured): no synthesized latency slot.
  const { rerender } = render(<StatsBadge stats={stats(12, null)} />);
  expect(screen.getByText('12fps')).toBeInTheDocument();
  expect(screen.queryByText(/ms$/)).toBeNull();
  // Nothing measured -> the chip does not render at all (honesty).
  rerender(<StatsBadge stats={stats(null, null)} />);
  expect(screen.queryByTestId('camera-stats')).toBeNull();
});

// ---------------------------------------------------------------------------
// Pure camera store: add / remove / cap / persist(reseed) / main reassignment.
// ---------------------------------------------------------------------------

test('store seeds config panes, re-seeds on a robot switch, and no-ops on the same key', () => {
  seedCameraPanes([HEAD, HAND], 'robotA');
  let s = getCameraState();
  expect(s.panes.map((p) => p.topic)).toEqual([HEAD, HAND]);
  expect(s.panes.every((p) => p.source === 'config')).toBe(true);
  expect(s.mainId).toBe(s.panes[0]!.id);

  // Same key: a persisted operator edit survives (no reset).
  addCameraPane('/camera/extra/image_raw');
  seedCameraPanes([HEAD, HAND], 'robotA');
  s = getCameraState();
  expect(s.panes).toHaveLength(3);

  // Robot switch (new key): full re-seed to the new robot's cameras.
  seedCameraPanes(['/only/one/image_raw'], 'robotB');
  s = getCameraState();
  expect(s.panes.map((p) => p.topic)).toEqual(['/only/one/image_raw']);
});

test('store add/remove respects the 4-pane cap and reassigns main on removal', () => {
  seedCameraPanes([HEAD, HAND], 'robotA');
  addCameraPane('/camera/c/image_raw');
  addCameraPane('/camera/d/image_raw');
  // Cap reached — a fifth add is a no-op.
  addCameraPane('/camera/e/image_raw');
  expect(getCameraState().panes).toHaveLength(MAX_CAMERA_PANES);

  // A duplicate topic is rejected too.
  removeCameraPane(getCameraState().panes[3]!.id);
  addCameraPane(HEAD);
  expect(getCameraState().panes).toHaveLength(3);

  // Remove the current main → the first surviving pane becomes main.
  const mainId = getCameraState().mainId!;
  removeCameraPane(mainId);
  const s = getCameraState();
  expect(s.mainId).not.toBe(mainId);
  expect(s.mainId).toBe(s.panes[0]!.id);
});

test('setMainCameraPane promotes a pane; operator panes are the removable ones', () => {
  seedCameraPanes([HEAD, HAND], 'robotA');
  addCameraPane('/camera/extra/image_raw');
  const extra = getCameraState().panes.find((p) => p.source === 'operator')!;
  setMainCameraPane(extra.id);
  expect(getCameraState().mainId).toBe(extra.id);
  // Config panes are not marked operator (UI refuses to remove them).
  expect(getCameraState().panes.filter((p) => p.source === 'operator')).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// imageTopicOptions: image topics only (add-camera dropdown source).
// ---------------------------------------------------------------------------

test('imageTopicOptions keeps only image topics and marks configured-but-offline', () => {
  const discovered = [
    { name: '/cam/left/image_raw', type: 'sensor_msgs/msg/Image' },
    { name: '/hsrb/hand_camera/image_raw/compressed', type: 'sensor_msgs/msg/CompressedImage' },
    { name: '/joint_states', type: 'sensor_msgs/msg/JointState' },
    { name: '/tf', type: 'tf2_msgs/msg/TFMessage' },
  ];
  const opts = imageTopicOptions(discovered, ['/cam/right/image_raw']);
  const names = opts.map((o) => o.name);
  expect(names).toContain('/cam/left/image_raw');
  expect(names).toContain('/hsrb/hand_camera/image_raw/compressed');
  // Non-image topics are excluded.
  expect(names).not.toContain('/joint_states');
  expect(names).not.toContain('/tf');
  // A configured camera not on the graph is offered but marked offline.
  const right = opts.find((o) => o.name === '/cam/right/image_raw');
  expect(right?.live).toBe(false);
});

// ---------------------------------------------------------------------------
// Component behavior.
// ---------------------------------------------------------------------------

// P5 regression: the camera tiles must come from config.stream.panes (the
// robot's real cameras), not a fixed mock top/left/right layout.
test('every configured camera streams live — main at its preset, subs at the low-res default', async () => {
  renderWithClient(<Cameras config={CONFIG} machine={MACHINE} />);

  // Main tile negotiates against the FIRST configured pane.
  await waitFor(() => expect(screen.getByTestId('main-camera-video')).toBeInTheDocument());
  expect(screen.getByText(/Main camera · head/)).toBeInTheDocument();

  // Exactly one sub tile for the second configured camera (HSR has 2 total),
  // carrying its own live video element — plus the "+ Add camera" tile.
  expect(screen.getAllByTestId('sub-camera-tile')).toHaveLength(1);
  expect(screen.getByTestId('sub-camera-video')).toBeInTheDocument();
  expect(screen.getByTestId('add-camera-tile')).toBeInTheDocument();

  await waitFor(() => {
    const starts = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => ({
        url: String(c[0]),
        body: (c[1] as RequestInit | undefined)?.body
          ? JSON.parse(String((c[1] as RequestInit).body))
          : undefined,
      }))
      .filter((c) => c.url.includes('/stream/start'));
    const main = starts.find((c) => c.body.topic === HEAD);
    const sub = starts.find((c) => c.body.topic === HAND);
    // Main follows the default 480p preset (854x480); the sub follows the low-res
    // default 240p (426x240) — the per-screen image budget (§3-2).
    expect(main?.body.max_width).toBe(854);
    expect(sub?.body.max_width).toBe(426);
  });
});

test('clicking a sub tile swaps its topic into the main slot at main resolution', async () => {
  renderWithClient(<Cameras config={CONFIG} machine={MACHINE} />);
  await waitFor(() => expect(screen.getByTestId('main-camera-video')).toBeInTheDocument());

  fireEvent.click(screen.getByTestId('sub-camera-tile'));

  await waitFor(() => expect(screen.getByText(/Main camera · hand/)).toBeInTheDocument());
  // The demoted topic (head) is now the sub tile.
  expect(
    screen.getByTitle(/head_rgbd_sensor.*click to make this the main camera/),
  ).toBeInTheDocument();

  await waitFor(() => {
    const starts = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => ({
        url: String(c[0]),
        body: (c[1] as RequestInit | undefined)?.body
          ? JSON.parse(String((c[1] as RequestInit).body))
          : undefined,
      }))
      .filter((c) => c.url.includes('/stream/start'));
    // hand was promoted: it re-negotiated at the main preset (854), not its old
    // 240p sub stream.
    expect(starts.some((c) => c.body.topic === HAND && c.body.max_width === 854)).toBe(true);
  });
});

test('main tile offers all five presets; sub tile offers only 360p/240p', async () => {
  renderWithClient(<Cameras config={CONFIG} machine={MACHINE} />);
  await waitFor(() => expect(screen.getByTestId('main-camera-video')).toBeInTheDocument());

  // Main preset group (Source + four caps) — scoped to the main tile since the
  // sub res toggle also uses 360p/240p.
  const mainRes = screen.getByTestId('main-res-group');
  for (const label of ['Source', '720p', '480p', '360p', '240p']) {
    expect(within(mainRes).getByRole('button', { name: label })).toBeInTheDocument();
  }

  // The sub tile's resolution toggle is restricted to the two lowest presets.
  const sub = screen.getByTestId('sub-camera-tile');
  expect(within(sub).getByRole('button', { name: '360p' })).toBeInTheDocument();
  expect(within(sub).getByRole('button', { name: '240p' })).toBeInTheDocument();
  expect(within(sub).queryByRole('button', { name: 'Source' })).toBeNull();
  expect(within(sub).queryByRole('button', { name: '720p' })).toBeNull();
  expect(within(sub).queryByRole('button', { name: '480p' })).toBeNull();
});

test('add-camera dropdown lists discovered image topics (only), and adding opens a removable pane', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/stream/start')) return Promise.resolve(jsonResponse({ stream_id: 's-1' }));
    if (url.includes('/stream/offer'))
      return Promise.resolve(jsonResponse({ type: 'answer', sdp: 'v=0 answer' }));
    if (url.includes('/topics'))
      return Promise.resolve(
        jsonResponse([
          { name: '/cam/side/image_raw', type: 'sensor_msgs/msg/Image' },
          { name: '/joint_states', type: 'sensor_msgs/msg/JointState' },
        ]),
      );
    return Promise.resolve(jsonResponse({}));
  });
  renderWithClient(<Cameras config={CONFIG} machine={MACHINE} />);
  await waitFor(() => expect(screen.getByTestId('main-camera-video')).toBeInTheDocument());

  const select = (await screen.findByTestId('add-camera-select')) as HTMLSelectElement;
  const values = Array.from(select.options)
    .map((o) => o.value)
    .filter(Boolean);
  // The discovered image topic is offered; the non-image one is not, and the
  // already-paned cameras (head/hand) are excluded.
  expect(values).toContain('/cam/side/image_raw');
  expect(values).not.toContain('/joint_states');
  expect(values).not.toContain(HEAD);

  fireEvent.change(select, { target: { value: '/cam/side/image_raw' } });
  // A third pane appears (added as a sub) and is removable.
  await waitFor(() => expect(screen.getAllByTestId('sub-camera-tile')).toHaveLength(2));
  expect(getCameraState().panes).toHaveLength(3);
  // Only the operator-added pane is removable — exactly one remove control.
  const removeBtn = screen.getByRole('button', { name: /remove .* camera/i });
  fireEvent.click(removeBtn);
  await waitFor(() => expect(screen.getAllByTestId('sub-camera-tile')).toHaveLength(1));
  expect(getCameraState().panes).toHaveLength(2);
});

test('config-derived sub panes are not removable', async () => {
  renderWithClient(<Cameras config={CONFIG} machine={MACHINE} />);
  await waitFor(() => expect(screen.getByTestId('main-camera-video')).toBeInTheDocument());
  // The one sub (a config camera) has no remove button.
  const sub = screen.getByTestId('sub-camera-tile');
  expect(within(sub).queryByRole('button', { name: /remove/ })).toBeNull();
});

test('no cameras configured renders a single explanatory placeholder, not empty fixed tiles', () => {
  const config: RuntimeConfig = { ...CONFIG, stream: { columns: 2, panes: [] } };
  renderWithClient(<Cameras config={config} machine={MACHINE} />);
  expect(screen.getByText(/No cameras configured/)).toBeInTheDocument();
  expect(screen.queryByTestId('main-camera-video')).not.toBeInTheDocument();
  expect(screen.queryByTestId('sub-camera-tile')).not.toBeInTheDocument();
});
