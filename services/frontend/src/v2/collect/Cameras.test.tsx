import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import type { RuntimeConfig } from '../../config';
import type { BatchMachine } from './useBatchMachine';
import {
  Cameras,
  StatsBadge,
  sameCameraHealth,
  shortCameraLabel,
  type CameraHealth,
} from './Cameras';
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

const stats = (fps: number | null, latencyMs: number | null, framesStaleMs: number | null = 0) => ({
  fps,
  latencyMs,
  framesStaleMs,
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

// ---------------------------------------------------------------------------
// Camera connecting / failed states (Apple P1): a blank tile must say which
// state it's in, and a failure must be recoverable in place.
// ---------------------------------------------------------------------------

test('a camera still connecting shows a spinner + "Connecting to camera…" (not a failure)', async () => {
  // A peer that negotiates but never reaches "connected" keeps the tile in the
  // connecting state.
  class PendingPeer extends FakePeerConnection {
    async setRemoteDescription() {
      // Intentionally does NOT flip connectionState to 'connected'.
    }
  }
  vi.stubGlobal('RTCPeerConnection', PendingPeer);
  renderWithClient(<Cameras config={CONFIG} machine={MACHINE} />);

  await waitFor(() =>
    expect(screen.getAllByTestId('camera-connecting-spinner').length).toBeGreaterThan(0),
  );
  expect(screen.getAllByText('Connecting to camera…').length).toBeGreaterThan(0);
  // Connecting is NOT failure: no Retry, no "unavailable" copy.
  expect(screen.queryByTestId('camera-retry')).toBeNull();
  expect(screen.queryByText(/Camera preview unavailable/)).toBeNull();
});

test('a failed camera shows the reason + a Retry that re-triggers the WebRTC connect', async () => {
  let headStarts = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const body = (init as RequestInit | undefined)?.body
      ? JSON.parse(String((init as RequestInit).body))
      : {};
    if (url.includes('/stream/start')) {
      if (body.topic === HEAD) {
        headStarts++;
        // The main camera's first connect fails; a retry succeeds.
        if (headStarts === 1) {
          return Promise.resolve(jsonResponse({ error: { message: 'boom' } }, 500));
        }
      }
      return Promise.resolve(jsonResponse({ stream_id: 's-1' }));
    }
    if (url.includes('/stream/offer'))
      return Promise.resolve(jsonResponse({ type: 'answer', sdp: 'v=0 answer' }));
    if (url.includes('/topics')) return Promise.resolve(jsonResponse([]));
    return Promise.resolve(jsonResponse({}));
  });
  renderWithClient(<Cameras config={CONFIG} machine={MACHINE} />);

  // The failed main tile shows the designed failed state, not just a dark box.
  const retryBtn = await screen.findByTestId('camera-retry');
  expect(screen.getByText(/Camera preview unavailable/)).toBeInTheDocument();
  expect(headStarts).toBe(1);

  // Retrying re-triggers the WebRTC connect (a second /stream/start for HEAD).
  fireEvent.click(retryBtn);
  await waitFor(() => expect(headStarts).toBeGreaterThanOrEqual(2));
});

// B1b (qa-ui p20): the tile kept claiming "8ms · 15fps" for 106 seconds after
// the source topic lost its publisher. The WebRTC track stays up and
// framesPerSecond keeps reporting its last value, so a rate is not evidence
// that pictures are arriving — only frames advancing is.
test('a tile whose frames stopped reports that, not its last frame rate', () => {
  render(<StatsBadge stats={stats(15, 8, 30_000)} />);
  const chip = screen.getByTestId('camera-stats');
  expect(chip).toHaveAttribute('data-stale', 'true');
  expect(chip).toHaveTextContent('no frames for 30s');
  // The stale rate is gone — it was the whole problem.
  expect(chip).not.toHaveTextContent('15fps');
  expect(chip).not.toHaveTextContent('8ms');
});

test('brief jitter below the deadline still shows the measured rate', () => {
  render(<StatsBadge stats={stats(15, 8, 500)} />);
  const chip = screen.getByTestId('camera-stats');
  expect(chip).not.toHaveAttribute('data-stale');
  expect(chip).toHaveTextContent('15fps');
});

test('an unmeasurable frame count is not reported as stale', () => {
  // null means we cannot tell yet — which is not the same as "stopped".
  render(<StatsBadge stats={stats(15, 8, null)} />);
  expect(screen.getByTestId('camera-stats')).not.toHaveAttribute('data-stale');
});

// A1 SUB-CAMERAS: the silent overlay was scoped to the MAIN tile, so with every
// topic dead qa-ui saw one tile owning up beside others still advertising
// "8ms · 15fps" — one screen giving two answers about the same dead graph.
test('any tile whose source topic is silent says so, not a frame rate', () => {
  render(<StatsBadge stats={stats(15, 8)} sourceLiveness="silent" />);
  const chip = screen.getByTestId('camera-stats');
  expect(chip).toHaveAttribute('data-topic-silent', 'true');
  expect(chip).toHaveTextContent('topic silent — showing the last frame');
  // The rate is gone: it was true about the transport and false about the
  // picture, which is exactly what made it misleading.
  expect(chip).not.toHaveTextContent('15fps');
});

test('a tile with a live topic still shows its measured rate', () => {
  render(<StatsBadge stats={stats(15, 8)} sourceLiveness="live" />);
  const chip = screen.getByTestId('camera-stats');
  expect(chip).not.toHaveAttribute('data-topic-silent');
  expect(chip).toHaveTextContent('15fps');
});

// UNMONITORED TILE: the same lie as A1, reachable by design. Nothing measures a
// topic outside the monitored set — on the HSR profile that is every camera the
// add-camera picker offers — so the tile fell back to the transport rate and
// reported a confident 15fps for a source that had stopped.
test('a tile nobody measures says so instead of showing the transport rate', () => {
  render(<StatsBadge stats={stats(15, 8)} sourceLiveness="unmonitored" />);
  const chip = screen.getByTestId('camera-stats');
  expect(chip).toHaveAttribute('data-topic-unmonitored', 'true');
  expect(chip).toHaveTextContent('not monitored — no rate available');
  // The rate is what read as "the picture is current", which is the one thing
  // nobody here can vouch for.
  expect(chip).not.toHaveTextContent('15fps');
  // And it does not claim the topic is dead either — that is not established.
  expect(chip).not.toHaveTextContent('silent');
});

test('a blind monitor makes no claim about the tile at all', () => {
  // Genuine unknown: the monitor is not answering, so this stays exactly as it
  // was — the measured transport values, with no verdict attached.
  render(<StatsBadge stats={stats(15, 8)} sourceLiveness="unknown" />);
  const chip = screen.getByTestId('camera-stats');
  expect(chip).toHaveTextContent('15fps');
  expect(chip).not.toHaveAttribute('data-topic-unmonitored');
  expect(chip).not.toHaveAttribute('data-topic-silent');
});

// ---------------------------------------------------------------------------
// Render-loop pin.
//
// Health leaves this component through a callback, so the price of a report is
// the parent's setState: it may only be paid when a FACT changed. Widening
// health from a boolean to an object broke that once — `stats` is a fresh
// object on every poll, so an un-memoized health object handed the parent
// something new on every render and its setState never settled. The failure
// does not show up as a red test: the Collect suites HUNG (exit 143). Hence a
// test that counts reports, since the bug's own signature is a test that never
// finishes.
// ---------------------------------------------------------------------------

test('camera health is reported once per fact, not once per render', async () => {
  // Real time keeps advancing the fake clock, so waitFor still works while we
  // can also jump the WebRTC stats poll forward on demand.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    // Seeded with the component's own seed key so its seeding effect is a
    // no-op: the panes exist on the FIRST render, which makes any second report
    // a genuine re-notify rather than the cameras arriving.
    seedCameraPanes([HEAD, HAND], JSON.stringify([HEAD, HAND]));

    // Counting the polls keeps the test honest: with no churn it would pass
    // while proving nothing.
    class CountingPeer extends FakePeerConnection {
      static statsCalls = 0;
      getStats() {
        CountingPeer.statsCalls++;
        return Promise.resolve(new Map());
      }
    }
    vi.stubGlobal('RTCPeerConnection', CountingPeer);

    const onHealthChange = vi.fn();
    const { rerender } = renderWithClient(
      <Cameras config={CONFIG} machine={MACHINE} onHealthChange={onHealthChange} />,
    );
    await waitFor(() => expect(screen.getByTestId('main-camera-video')).toBeInTheDocument());
    expect(onHealthChange).toHaveBeenCalledTimes(1);
    expect(onHealthChange.mock.lastCall?.[0]).toEqual({
      streamFailed: false,
      streamsDown: 0,
      streamFault: null,
      framesStale: false,
      silentTopics: 0,
      unmonitoredTopics: 0,
      totalCameras: 2,
    });

    // Five seconds of stats polls: every tick resolves a fresh reports object
    // and the hook setStates a fresh StreamStats carrying the same facts — one
    // render each, plus a topics refetch at 5s. This is the exact churn that
    // used to re-report.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(CountingPeer.statsCalls).toBeGreaterThanOrEqual(3);

    // …and re-renders driven from above (the elapsed clock ticks once a second
    // while recording), which say nothing about the cameras either.
    for (const elapsedMs of [1000, 2000, 3000]) {
      rerender(
        <Cameras
          config={CONFIG}
          machine={{ phase: 'ready', elapsedMs } as unknown as BatchMachine}
          onHealthChange={onHealthChange}
        />,
      );
    }

    expect(onHealthChange).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

test('a health comparison covers every field of the report', () => {
  const base: CameraHealth = {
    streamFailed: false,
    streamsDown: 0,
    streamFault: null,
    framesStale: false,
    silentTopics: 0,
    unmonitoredTopics: 0,
    totalCameras: 2,
  };
  expect(sameCameraHealth(base, { ...base })).toBe(true);
  // Each fact must be able to force a report on its own: a comparison that
  // skips one leaves that fact frozen on screen forever.
  const differing: CameraHealth[] = [
    { ...base, streamFailed: true },
    { ...base, streamsDown: 1 },
    { ...base, streamFault: 'peer' },
    { ...base, framesStale: true },
    { ...base, silentTopics: 1 },
    { ...base, unmonitoredTopics: 1 },
    { ...base, totalCameras: 3 },
  ];
  for (const next of differing) expect(sameCameraHealth(base, next)).toBe(false);
  // A further fact added to CameraHealth without a case here fails right there
  // — as `streamsDown` and `streamFault` did when E-37 added them.
  expect(differing).toHaveLength(Object.keys(base).length);
});

// E-37, the wiring rather than the wording. Every pane negotiates its OWN
// stream, and only the main tile's phase used to reach `onHealthChange` — so a
// sub camera with no video was invisible to the System card, which is how four
// black tiles beside one working stream read "5 cameras OK".
//
// This drives a REAL failure (the streamer answers the offer with an error, as
// it does when the service is down) rather than asserting a prop is passed,
// because a prop that is passed and never called is exactly the hole this test
// exists to catch.
test('a sub camera with no video reaches the health report, with its cause', async () => {
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/stream/start')) return Promise.resolve(jsonResponse({ stream_id: 's-1' }));
    // The streamer is up enough to hand out a stream id and then fails the
    // negotiation — every pane fails the same way, together.
    if (url.includes('/stream/offer')) return Promise.resolve(jsonResponse({}, 502));
    if (url.includes('/topics')) return Promise.resolve(jsonResponse([]));
    return Promise.resolve(jsonResponse({}));
  });

  const reports: CameraHealth[] = [];
  renderWithClient(
    <Cameras config={CONFIG} machine={MACHINE} onHealthChange={(h) => reports.push(h)} />,
  );

  await waitFor(() => {
    const last = reports[reports.length - 1];
    expect(last?.streamsDown).toBeGreaterThanOrEqual(2);
  });
  const last = reports[reports.length - 1]!;
  // Both panes, not just the main one — the count is what stops the card
  // claiming the wall is fine.
  expect(last.streamsDown).toBe(last.totalCameras);
  // And the cause is carried, so the row can say which of the three problems
  // it is instead of "down".
  expect(last.streamFault).toBe('signaling');
});
