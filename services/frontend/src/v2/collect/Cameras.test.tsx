import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import type { RuntimeConfig } from '../../config';
import type { BatchMachine } from './useBatchMachine';
import { Cameras, shortCameraLabel } from './Cameras';

const CONFIG: RuntimeConfig = {
  endpoints: { api: '/api/v1', events: '/api/v1/events', webrtc: 'http://localhost:8002' },
  tabs: [],
  defaults: {
    default_topics: [
      '/hsrb/head_rgbd_sensor/rgb/image_rect_color/compressed',
      '/hsrb/hand_camera/image_raw/compressed',
    ],
  },
  stream: {
    columns: 2,
    panes: [
      { topic: '/hsrb/head_rgbd_sensor/rgb/image_rect_color/compressed' },
      { topic: '/hsrb/hand_camera/image_raw/compressed' },
    ],
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
  vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/stream/start')) return Promise.resolve(jsonResponse({ stream_id: 's-1' }));
    if (url.includes('/stream/offer'))
      return Promise.resolve(jsonResponse({ type: 'answer', sdp: 'v=0 answer' }));
    return Promise.resolve(jsonResponse({}));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('shortCameraLabel derives a human name from real robot topics', () => {
  expect(shortCameraLabel('/hsrb/head_rgbd_sensor/rgb/image_rect_color/compressed')).toBe('head');
  expect(shortCameraLabel('/hsrb/hand_camera/image_raw/compressed')).toBe('hand');
});

// P5 regression: the camera tiles must come from config.stream.panes (the
// robot's real cameras), not a fixed mock top/left/right layout that never
// matches a real topic name.
test('every configured camera streams live — main at its preset, subs at the forced cap', async () => {
  renderWithClient(<Cameras config={CONFIG} machine={MACHINE} />);

  // Main tile negotiates against the FIRST configured pane.
  await waitFor(() => expect(screen.getByTestId('main-camera-video')).toBeInTheDocument());
  expect(screen.getByText(/Main camera · head/)).toBeInTheDocument();

  // Exactly one sub tile for the second configured camera (HSR has 2 total) —
  // never a fabricated 3rd tile — and it carries its own live video element.
  expect(screen.getAllByTestId('sub-camera-tile')).toHaveLength(1);
  expect(screen.getByTestId('sub-camera-video')).toBeInTheDocument();

  await waitFor(() => {
    const starts = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => ({
        url: String(c[0]),
        body: c[1] ? JSON.parse(String((c[1] as RequestInit).body)) : undefined,
      }))
      .filter((c) => c.url.includes('/stream/start'));
    const main = starts.find(
      (c) => c.body.topic === '/hsrb/head_rgbd_sensor/rgb/image_rect_color/compressed',
    );
    const sub = starts.find((c) => c.body.topic === '/hsrb/hand_camera/image_raw/compressed');
    // Main follows the default 480p preset; the sub is force-capped to 320x240
    // (the per-screen image budget: one operator-resolution stream at a time).
    expect(main?.body.max_width).toBe(640);
    expect(sub?.body.max_width).toBe(320);
  });
});

test('clicking a sub tile swaps its topic into the main slot at main resolution', async () => {
  renderWithClient(<Cameras config={CONFIG} machine={MACHINE} />);
  await waitFor(() => expect(screen.getByTestId('main-camera-video')).toBeInTheDocument());

  fireEvent.click(screen.getByTestId('sub-camera-tile'));

  await waitFor(() => expect(screen.getByText(/Main camera · hand/)).toBeInTheDocument());
  // The demoted topic (head) is now the sub tile.
  expect(screen.getByTitle(/head_rgbd_sensor.*click to make this the main camera/)).toBeInTheDocument();

  await waitFor(() => {
    const starts = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => ({
        url: String(c[0]),
        body: c[1] ? JSON.parse(String((c[1] as RequestInit).body)) : undefined,
      }))
      .filter((c) => c.url.includes('/stream/start'));
    // hand was promoted: it must have re-negotiated at the main preset (640),
    // not just kept its old 320 sub stream.
    expect(
      starts.some(
        (c) => c.body.topic === '/hsrb/hand_camera/image_raw/compressed' && c.body.max_width === 640,
      ),
    ).toBe(true);
  });
});

test('no cameras configured renders a single explanatory placeholder, not empty fixed tiles', () => {
  const config: RuntimeConfig = { ...CONFIG, stream: { columns: 2, panes: [] } };
  renderWithClient(<Cameras config={config} machine={MACHINE} />);
  expect(screen.getByText(/No cameras configured/)).toBeInTheDocument();
  expect(screen.queryByTestId('main-camera-video')).not.toBeInTheDocument();
  expect(screen.queryByTestId('sub-camera-tile')).not.toBeInTheDocument();
});
