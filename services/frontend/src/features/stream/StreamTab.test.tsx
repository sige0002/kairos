import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import type { RuntimeConfig } from '../../config';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { StreamTab } from './StreamTab';
import { useUiStore } from '../../store/uiStore';

const CONFIG: RuntimeConfig = {
  endpoints: {
    api: '/api/v1',
    events: '/api/v1/events',
    webrtc: 'http://localhost:8002',
  },
  tabs: [],
  defaults: {},
  schemas: {},
};

// Minimal RTCPeerConnection stub that drives the negotiation to "connected".
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
  // Report a 640x480 (4:3) inbound video frame so the stats poll populates
  // width/height (drives the pane's aspect-ratio fit and the resolution overlay).
  getStats() {
    return Promise.resolve(
      new Map<string, Record<string, unknown>>([
        [
          'inbound',
          {
            type: 'inbound-rtp',
            kind: 'video',
            framesPerSecond: 15,
            frameWidth: 640,
            frameHeight: 480,
            framesDecoded: 100,
            jitterBufferDelay: 0.1,
            jitterBufferEmittedCount: 10,
          },
        ],
      ]),
    );
  }
}

beforeEach(() => {
  setApiBase('/api/v1');
  // Reset the persisted stream panes so they don't leak between tests.
  useUiStore.setState({ streamPanes: [], streamPaneSeq: 0, streamPanesSeededKey: null });
  vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/topics')) {
      return Promise.resolve(
        jsonResponse([{ name: '/camera/head/image_raw', type: 'sensor_msgs/Image' }]),
      );
    }
    if (url.includes('/stream/start')) {
      return Promise.resolve(jsonResponse({ stream_id: 's-1' }));
    }
    if (url.includes('/stream/offer')) {
      return Promise.resolve(jsonResponse({ type: 'answer', sdp: 'v=0 answer' }));
    }
    return Promise.resolve(jsonResponse({}));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('negotiates a WebRTC preview and reaches connected', async () => {
  renderWithClient(<StreamTab config={CONFIG} />);

  // Default topic is taken from discovery; negotiation runs to connected.
  await waitFor(() =>
    expect(screen.getByTestId('stream-phase')).toHaveTextContent('connected'),
  );

  const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
    String(c[0]),
  );
  expect(calls.some((u) => u.includes('http://localhost:8002/stream/start'))).toBe(
    true,
  );
  expect(calls.some((u) => u.includes('http://localhost:8002/stream/offer'))).toBe(
    true,
  );
});

test('lowering the preview resolution stops then restarts at the new cap', async () => {
  renderWithClient(<StreamTab config={CONFIG} />);
  await waitFor(() =>
    expect(screen.getByTestId('stream-phase')).toHaveTextContent('connected'),
  );

  const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
  fetchMock.mockClear();

  fireEvent.change(screen.getByTestId('stream-resolution'), {
    target: { value: '360p' },
  });

  // The streamer keys a stream by topic and ignores new caps on an existing one,
  // so the pane stops the shared stream, then re-starts carrying 360p (640x360).
  await waitFor(() => {
    const startBodies = fetchMock.mock.calls
      .filter((c) => String(c[0]).includes('/stream/start'))
      .map((c) => JSON.parse(String((c[1] as RequestInit).body)) as Record<string, unknown>);
    expect(startBodies.some((b) => b.max_width === 640 && b.max_height === 360)).toBe(true);
  });
  expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/stream/stop'))).toBe(true);
});

test('fits the pane to the video aspect ratio (drops the 16:9 box, no pillarbox)', async () => {
  renderWithClient(<StreamTab config={CONFIG} />);
  await waitFor(() =>
    expect(screen.getByTestId('stream-phase')).toHaveTextContent('connected'),
  );
  // Once the stats poll reports a 640x480 frame, the surface drops its fixed
  // `aspect-video` (16:9) box and takes the real 4:3 ratio so there are no bars.
  await waitFor(
    () => {
      const surface = screen.getByTestId('stream-video').parentElement as HTMLElement;
      expect(surface.className).not.toContain('aspect-video');
      expect(surface.style.aspectRatio).toMatch(/^1\.33/);
    },
    { timeout: 3000 },
  );
});

test('opens the panes configured in config.stream', async () => {
  const config: RuntimeConfig = {
    ...CONFIG,
    // The configured topics must be selectable options; seed them so the panes
    // keep them (only /camera/head/image_raw is in the discovery mock).
    defaults: {
      default_topics: ['/camera/head/image_raw', '/camera/hand/image_raw'],
    },
    stream: {
      columns: 2,
      panes: [{ topic: '/camera/head/image_raw' }, { topic: '/camera/hand/image_raw' }],
    },
  };
  renderWithClient(<StreamTab config={config} />);

  // Two preview panes open up-front, one per configured topic.
  await waitFor(() =>
    expect(screen.getAllByTestId('stream-video')).toHaveLength(2),
  );
  const selects = screen.getAllByLabelText('camera topic') as HTMLSelectElement[];
  expect(selects.map((s) => s.value)).toEqual([
    '/camera/head/image_raw',
    '/camera/hand/image_raw',
  ]);
});

test('can add a second camera preview', async () => {
  renderWithClient(<StreamTab config={CONFIG} />);

  await waitFor(() => expect(screen.getByTestId('stream-video')).toBeInTheDocument());
  expect(screen.getAllByTestId('stream-video')).toHaveLength(1);

  fireEvent.click(screen.getByRole('button', { name: /add camera/i }));

  // A second independent preview pane (and its video surface) appears.
  expect(screen.getAllByTestId('stream-video')).toHaveLength(2);
  expect(screen.getAllByLabelText('camera topic')).toHaveLength(2);
});

// Regression (L-11): a camera pane added at runtime must survive the Stream tab
// unmounting on navigation — panes live in the persistent UI store, not local
// state, so a tab round-trip can't drop back to the configured layout.
test('an added camera pane survives a remount', async () => {
  const { unmount } = renderWithClient(<StreamTab config={CONFIG} />);
  await waitFor(() => expect(screen.getByTestId('stream-video')).toBeInTheDocument());

  fireEvent.click(screen.getByRole('button', { name: /add camera/i }));
  expect(screen.getAllByTestId('stream-video')).toHaveLength(2);

  unmount(); // leave the Stream/Live tab
  renderWithClient(<StreamTab config={CONFIG} />); // come back

  await waitFor(() => expect(screen.getAllByTestId('stream-video')).toHaveLength(2));
});

// The Live stream grid maximizes up to a 2x2 (4) layout that fits the viewport
// without page scroll, so previews are capped at 4: "+ Add camera" disables.
test('caps previews at 4 (add disabled at max)', async () => {
  useUiStore.setState({
    streamPanes: [0, 1, 2, 3].map((id) => ({ id, topic: '' })),
    streamPaneSeq: 4,
    // Match the key the component computes for CONFIG (no stream) so the seed
    // effect no-ops and preserves these 4 panes.
    streamPanesSeededKey: JSON.stringify([]),
  });
  renderWithClient(<StreamTab config={CONFIG} fit />);

  await waitFor(() => expect(screen.getAllByLabelText('camera topic')).toHaveLength(4));
  const add = screen.getByRole('button', { name: /add camera/i });
  expect(add).toBeDisabled();
  fireEvent.click(add); // no-op at max
  expect(screen.getAllByLabelText('camera topic')).toHaveLength(4);
});

test('shows a fallback error when WebRTC is unsupported', async () => {
  vi.stubGlobal('RTCPeerConnection', undefined);
  renderWithClient(<StreamTab config={CONFIG} />);

  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent(/not supported/i),
  );
});
