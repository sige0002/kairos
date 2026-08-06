// E-37, the half that was still open: a stream that NEVER connects.
//
// MEASURED, not theorised (Batch D, real browser against the real stack with
// the streamer running). With the media path broken but signaling healthy —
// candidate ports rewritten, `/stream/start` and `/stream/offer` answering
// 201/200 for real — both <video> elements sat at 0x0 with readyState 0 while
// the System card's Cameras row read "2 cameras OK". For 150 seconds:
//
//   t=15s  0x0 rs0  "2 cameras OK"
//   t=150s 0x0 rs0  "2 cameras OK"
//
// The mechanism is that the row's green was derived from the ABSENCE OF A
// FAILURE REPORT, not the presence of video. `streamsDown` counts panes whose
// peer connection reached `failed`, and a connection whose candidates go
// nowhere never gets there — ICE simply never completes — so nothing is ever
// reported and the row stays OK indefinitely. `framesStale` does not cover it
// either: it watches the main stream STOPPING after frames flowed, and these
// panes never delivered a first frame.
//
// So the fix is a SEPARATE PREDICATE resting on the evidence directly (no
// video, for longer than connecting takes) rather than on a failure signal that
// never arrives. These tests pin both sides of it, because a predicate that
// fires on a healthy connection would be worse than the hole it closes: it
// would make every page load flash a camera warning.

import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { setApiBase } from '../../api/client';
import { jsonResponse, makeTestClient } from '../../test/renderWithClient';
import {
  Cameras,
  __resetNoVideoAfterMs,
  __setNoVideoAfterMs,
  type CameraHealth,
} from './Cameras';
import { __resetCameraStore } from './cameraStore';
import { cameraSummary } from './warnings';
import type { BatchMachine } from './useBatchMachine';

const HEAD = '/hsrb/head_rgbd_sensor/rgb/image_rect_color/compressed';
const HAND = '/hsrb/hand_camera/image_raw/compressed';

const CONFIG = {
  endpoints: {
    api: '/api/v1',
    events: '/api/v1/events',
    webrtc: 'http://localhost:8002',
  },
  tabs: [],
  defaults: { default_topics: [HEAD, HAND] },
  stream: { columns: 2, panes: [{ topic: HEAD }, { topic: HAND }] },
  schemas: {},
} as never;

const MACHINE = { phase: 'ready', elapsedMs: 0 } as unknown as BatchMachine;

/** Negotiates all the way to `connected`, like a healthy stack. */
class ConnectingPeerConnection {
  connectionState = 'new';
  iceGatheringState = 'complete';
  localDescription: { type: string; sdp: string } | null = null;
  protected listeners: Record<string, ((ev?: unknown) => void)[]> = {};
  addEventListener(type: string, cb: (ev?: unknown) => void) {
    (this.listeners[type] ??= []).push(cb);
  }
  removeEventListener() {}
  addTransceiver() {}
  async createOffer() {
    return { type: 'offer', sdp: 'v=0 offer' };
  }
  async setLocalDescription(d: { type: string; sdp: string }) {
    this.localDescription = d;
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

/**
 * Accepts the answer and then sits there — exactly what a broken candidate
 * produces. NOT `failed`: that is the whole point. The browser's ICE agent goes
 * on checking an address that answers nothing, so the connection state never
 * leaves `connecting` and no failure is ever reported.
 */
class NeverConnectingPeerConnection extends ConnectingPeerConnection {
  override async setRemoteDescription() {
    this.connectionState = 'connecting';
    this.listeners['connectionstatechange']?.forEach((cb) => cb());
  }
}

function renderCameras(onHealth: (h: CameraHealth) => void) {
  const client = makeTestClient();
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  render(<Cameras config={CONFIG} machine={MACHINE} onHealthChange={onHealth} />, {
    wrapper: Wrapper,
  });
}

beforeEach(() => {
  setApiBase('/api/v1');
  __resetCameraStore();
  // Start with a threshold NOTHING in a unit test can cross, so the "not yet"
  // assertions below are facts rather than races. Each test shortens it when it
  // wants the ticker to cross. See the note on advancing, below.
  __setNoVideoAfterMs(60_000);
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    // Signaling is HEALTHY in both cases — that is what makes this the
    // never-connects case and not a `signaling` failure wearing a hat.
    if (url.includes('/stream/start'))
      return Promise.resolve(jsonResponse({ stream_id: 's-1' }));
    if (url.includes('/stream/offer'))
      return Promise.resolve(jsonResponse({ type: 'answer', sdp: 'v=0 answer' }));
    if (url.includes('/topics')) return Promise.resolve(jsonResponse([]));
    return Promise.resolve(jsonResponse({}));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  __resetNoVideoAfterMs();
});

/**
 * Cross the threshold: shorten it, then let the 1 Hz ticker fire once.
 *
 * Shortening it HERE rather than in `beforeEach` is what makes this test
 * deterministic, and that is not a style choice — the first version set 40 ms
 * up front and flaked 1 run in 8 under full-suite parallel load. With a 40 ms
 * threshold live from the start, any setup slower than 40 ms (which is ordinary
 * when eight files share a machine) meant the panes had ALREADY crossed it
 * before the "not yet" assertion ran: `expected 1 to be +0`. The race was
 * between the test's own setup and its own threshold, so no amount of waiting
 * would have fixed it — only removing the overlap does.
 *
 * Real clock on purpose. Fake timers would have to fake `performance` too,
 * because `waitingSince` is taken on the monotonic clock (E-32) — and
 * installing that clock after the panes have taken their baseline computes a
 * NEGATIVE wait, which made an earlier version fail against a correct
 * implementation. Shortening the threshold keeps the ticker, the baseline and
 * the comparison exactly as they ship.
 */
async function crossThreshold(): Promise<void> {
  __setNoVideoAfterMs(40);
  await new Promise((r) => setTimeout(r, 1400));
}

test('a stream that never connects is reported, though nothing ever failed', async () => {
  vi.stubGlobal('RTCPeerConnection', NeverConnectingPeerConnection);
  let health: CameraHealth | null = null;
  renderCameras((h) => {
    health = h;
  });

  await waitFor(() => expect(health).not.toBeNull());
  // Positive control on the PRECONDITION: nothing has failed. If this were
  // non-zero the test would be measuring the old predicate, not the new one.
  await waitFor(() => expect(health!.totalCameras).toBeGreaterThan(0));
  expect(health!.streamsDown).toBe(0);
  expect(health!.streamsNoVideo).toBe(0); // not yet — connecting is not a fault

  await crossThreshold();

  // Still nothing "failed" — and now the row says so anyway.
  expect(health!.streamsDown).toBe(0);
  expect(health!.streamsNoVideo).toBeGreaterThan(0);

  // The claim as the operator reads it, through the real summary function, so
  // this pins the whole chain rather than an intermediate count.
  const row = cameraSummary({
    totalCameras: health!.totalCameras,
    streamsDown: health!.streamsDown,
    streamFault: health!.streamFault,
    streamsNoVideo: health!.streamsNoVideo,
    silentTopics: health!.silentTopics,
    unmonitoredTopics: health!.unmonitoredTopics,
    framesStale: health!.framesStale,
  });
  expect(row.tone).toBe('amber');
  expect(row.chip).toBe('CHECK');
  expect(row.value).toMatch(/no video/);
  expect(row.value).toMatch(/still connecting/);
  // It must not invent a cause: signaling answered and nothing reported a
  // failure, so which of the three reasons applies is genuinely not known.
  expect(row.value).not.toMatch(/the network connection dropped/);
  expect(row.value).not.toMatch(/the streamer did not answer/);
});

test('a healthy connection never trips it, however long it runs', async () => {
  vi.stubGlobal('RTCPeerConnection', ConnectingPeerConnection);
  let health: CameraHealth | null = null;
  renderCameras((h) => {
    health = h;
  });

  await waitFor(() => expect(health).not.toBeNull());
  await waitFor(() => expect(health!.totalCameras).toBeGreaterThan(0));

  await crossThreshold();

  // The control that keeps the predicate honest: a connected pane is not
  // waiting for anything, so a threshold long past does not accuse it. Without
  // this, "always report no video" would pass the test above.
  expect(health!.streamsNoVideo).toBe(0);
  const row = cameraSummary({
    totalCameras: health!.totalCameras,
    streamsDown: health!.streamsDown,
    streamFault: health!.streamFault,
    streamsNoVideo: health!.streamsNoVideo,
    silentTopics: health!.silentTopics,
    unmonitoredTopics: health!.unmonitoredTopics,
    framesStale: health!.framesStale,
  });
  expect(row.value).not.toMatch(/still connecting/);
});

// Ordering: a pane that named its cause is more use to the operator than one
// that has not finished trying, so a reported failure keeps the row. Pinned
// because the two predicates are independent and could otherwise be reordered
// without any test noticing.
test('a reported failure still wins the row over "still connecting"', () => {
  const row = cameraSummary({
    totalCameras: 3,
    streamsDown: 1,
    streamFault: 'peer',
    streamsNoVideo: 2,
    silentTopics: 0,
    unmonitoredTopics: 0,
    framesStale: false,
  });
  expect(row.value).toMatch(/the network connection dropped/);
  expect(row.value).not.toMatch(/still connecting/);
});
