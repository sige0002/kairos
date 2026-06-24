import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import type { RuntimeConfig } from '../../config';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { StreamTab } from './StreamTab';

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
}

beforeEach(() => {
  setApiBase('/api/v1');
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

test('shows a fallback error when WebRTC is unsupported', async () => {
  vi.stubGlobal('RTCPeerConnection', undefined);
  renderWithClient(<StreamTab config={CONFIG} />);

  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent(/not supported/i),
  );
});
