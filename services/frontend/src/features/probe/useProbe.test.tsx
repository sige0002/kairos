// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useProbeSeries } from './useProbe';

let sources: FakeSource[];
let frames: Map<number, FrameRequestCallback>;
let frameId: number;
let now: number;
class FakeSource {
  static CLOSED = 2;
  readyState = 1;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  close = vi.fn();
  constructor() {
    sources.push(this);
  }
}
const SERIES = [
  { id: 'a', topic: '/a', field: 'value' },
  { id: 'b', topic: '/b', field: 'value' },
];
beforeEach(() => {
  sources = [];
  frames = new Map();
  frameId = 0;
  now = 1000;
  vi.stubGlobal('EventSource', FakeSource);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function send(index: number, topic: string, value: number | null) {
  act(() =>
    sources[index]!.onmessage?.({
      data: JSON.stringify({ topic, values: { value }, t: now / 1000 }),
    } as MessageEvent<string>),
  );
}
function flush() {
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(now));
  });
}

test('coalesces display updates while retaining every aligned sample and null', () => {
  const { result } = renderHook(() => useProbeSeries(SERIES, true));
  const original = result.current.data;
  send(0, '/a', 1);
  send(1, '/b', 2);
  send(0, '/a', null);
  expect(frames.size).toBe(1);
  expect(result.current.data).toBe(original);
  flush();
  expect(result.current.data).toEqual([
    [1, 1, 1],
    [1, 1, null],
    [null, 2, 2],
  ]);
});

test('pause publishes the pending tail and cancels scheduled work; resume preserves history', () => {
  const { result, rerender } = renderHook(({ live }) => useProbeSeries(SERIES, live), {
    initialProps: { live: true },
  });
  send(0, '/a', 1);
  rerender({ live: false });
  expect(frames.size).toBe(0);
  expect(result.current.data[1]).toEqual([1]);
  expect(result.current.status).toBe('idle');
  expect(sources[0]!.close).toHaveBeenCalledOnce();
  send(0, '/a', 999);
  expect(result.current.data[1]).toEqual([1]);
  rerender({ live: true });
  send(2, '/a', 2);
  flush();
  expect(result.current.data[1]).toEqual([1, 2]);
});

test('series changes and unmount cancel old callbacks and reject late messages', () => {
  const { result, rerender, unmount } = renderHook(
    ({ series }) => useProbeSeries(series, true),
    { initialProps: { series: SERIES } },
  );
  send(0, '/a', 1);
  const oldFrame = [...frames.values()][0]!;
  rerender({ series: [SERIES[1]!] });
  expect(frames.size).toBe(0);
  act(() => oldFrame(now));
  send(0, '/a', 999);
  send(2, '/b', 2);
  flush();
  expect(result.current.data).toEqual([[1], [2]]);
  send(2, '/b', 3);
  unmount();
  expect(frames.size).toBe(0);
  expect(sources.every((source) => source.close.mock.calls.length === 1)).toBe(true);
});

test('a suspended display remains bounded and expiration still follows the selected time window', () => {
  const { result, rerender } = renderHook(
    ({ windowSec }) => useProbeSeries([SERIES[0]!], true, 30, windowSec),
    { initialProps: { windowSec: 60 } },
  );
  for (let i = 0; i < 4000; i++) send(0, '/a', i);
  expect(frames.size).toBe(1);
  flush();
  expect(result.current.data[0]).toHaveLength(3600);
  expect(result.current.data[1]![0]).toBe(400);
  rerender({ windowSec: 10 });
  now = 12000;
  send(0, '/a', 4000);
  flush();
  expect(result.current.data).toEqual([[12], [4000]]);
  expect(sources).toHaveLength(1);
});
