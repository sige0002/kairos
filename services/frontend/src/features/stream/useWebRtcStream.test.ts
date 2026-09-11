// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
import { afterEach, expect, test, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { streamFromTrackEvent, useWebRtcStream } from './useWebRtcStream';

// jsdom has no MediaStream; stub it so the fallback path is exercisable.
class FakeMediaStream {
  tracks: unknown[];
  constructor(tracks: unknown[] = []) {
    this.tracks = tracks;
  }
}

afterEach(() => vi.unstubAllGlobals());

test('uses the provided stream when present (has msid)', () => {
  vi.stubGlobal('MediaStream', FakeMediaStream);
  const provided = { id: 'provided' } as unknown as MediaStream;
  const track = { id: 't' } as unknown as MediaStreamTrack;
  const ev = { streams: [provided], track } as unknown as RTCTrackEvent;
  expect(streamFromTrackEvent(ev)).toBe(provided);
});

test('falls back to a new MediaStream([track]) when streams is empty (no msid)', () => {
  vi.stubGlobal('MediaStream', FakeMediaStream);
  const track = { id: 't' } as unknown as MediaStreamTrack;
  const ev = { streams: [], track } as unknown as RTCTrackEvent;
  const result = streamFromTrackEvent(ev) as unknown as FakeMediaStream;
  expect(result).toBeInstanceOf(FakeMediaStream);
  expect(result.tracks).toEqual([track]);
});

test('resolution and topic changes replace only this peer, never stop a shared stream', async () => {
  const peers: FakePeer[] = [];
  class FakePeer extends EventTarget {
    iceGatheringState = 'complete';
    localDescription = { type: 'offer', sdp: 'offer' };
    addTransceiver = vi.fn();
    createOffer = vi.fn(async () => this.localDescription);
    setLocalDescription = vi.fn(async () => {});
    setRemoteDescription = vi.fn(async () => {});
    getSenders = vi.fn(() => []);
    close = vi.fn();
    constructor() {
      super();
      peers.push(this);
    }
  }
  vi.stubGlobal('RTCPeerConnection', FakePeer);
  const fetchMock = vi.fn(async (url: string) => ({
    ok: true,
    json: async () =>
      url.endsWith('/stream/start')
        ? { stream_id: 'profile' }
        : { type: 'answer', sdp: 'answer' },
  }));
  vi.stubGlobal('fetch', fetchMock);
  const { rerender, unmount } = renderHook(
    (props) => useWebRtcStream({ webrtcBase: '/webrtc', ...props }),
    { initialProps: { topic: '/cam/front', maxWidth: 426, maxHeight: 240 } },
  );
  await waitFor(() => expect(peers[0]?.setRemoteDescription).toHaveBeenCalledOnce());
  rerender({ topic: '/cam/front', maxWidth: 854, maxHeight: 480 });
  await waitFor(() => expect(peers[1]?.setRemoteDescription).toHaveBeenCalledOnce());
  expect(peers[0]?.close).toHaveBeenCalledOnce();
  rerender({ topic: '/cam/back', maxWidth: 854, maxHeight: 480 });
  await waitFor(() => expect(peers[2]?.setRemoteDescription).toHaveBeenCalledOnce());
  expect(peers[1]?.close).toHaveBeenCalledOnce();
  unmount();
  expect(peers[2]?.close).toHaveBeenCalledOnce();
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
    '/webrtc/stream/start',
    '/webrtc/stream/offer',
    '/webrtc/stream/start',
    '/webrtc/stream/offer',
    '/webrtc/stream/start',
    '/webrtc/stream/offer',
  ]);
});
