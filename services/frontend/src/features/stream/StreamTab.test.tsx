import { screen, waitFor } from '@testing-library/react';
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

test('shows a fallback error when WebRTC is unsupported', async () => {
  vi.stubGlobal('RTCPeerConnection', undefined);
  renderWithClient(<StreamTab config={CONFIG} />);

  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent(/not supported/i),
  );
});
