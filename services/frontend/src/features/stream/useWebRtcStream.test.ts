// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
import { afterEach, expect, test, vi } from 'vitest';
import { streamFromTrackEvent } from './useWebRtcStream';

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
