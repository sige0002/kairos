import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';
import { setApiBase } from '../../api/client';
import { makeTestClient, jsonResponse } from '../../test/renderWithClient';
import { useUiStore } from '../../store/uiStore';
import {
  batchMachineReducer as reducer,
  createBatchMachineState as createState,
  useBatchMachine,
  EPISODES_PER_BATCH,
} from './useBatchMachine';

// ---------------------------------------------------------------------------
// Pure reducer transitions — no React needed.
// ---------------------------------------------------------------------------

test('ready -> arming -> recording on a successful start', () => {
  let s = createState();
  expect(s.phase).toBe('ready');
  s = reducer(s, { type: 'START_REQUESTED' });
  expect(s.phase).toBe('arming');
  s = reducer(s, { type: 'START_SUCCEEDED', runId: 'run_1' });
  expect(s.phase).toBe('recording');
  expect(s.currentRunId).toBe('run_1');
});

test('a failed start returns to ready with an error, never reaching recording', () => {
  let s = createState();
  s = reducer(s, { type: 'START_REQUESTED' });
  s = reducer(s, { type: 'START_FAILED', message: 'boom' });
  expect(s.phase).toBe('ready');
  expect(s.startError).toBe('boom');
});

test('recording -> saving -> quickcheck -> result', () => {
  let s = createState();
  s = reducer(s, { type: 'START_REQUESTED' });
  s = reducer(s, { type: 'START_SUCCEEDED', runId: null });
  s = reducer(s, { type: 'STOP_REQUESTED' });
  expect(s.phase).toBe('saving');
  s = reducer(s, { type: 'SAVED' });
  expect(s.phase).toBe('quickcheck');
  s = reducer(s, { type: 'QUICK_CHECK_DONE' });
  expect(s.phase).toBe('result');
  expect(s.pendingTask).toBeNull();
});

// Failure-reason requirement: confirming a Failure result without a reason is
// a no-op; picking one unblocks it.
test('CONFIRM_EPISODE requires a fail reason when the result is Failure', () => {
  let s = createState();
  s = { ...s, phase: 'result' };
  s = reducer(s, { type: 'PICK_RESULT', result: 'fail' });
  expect(s.pendingTask).toBe('fail');

  const blocked = reducer(s, { type: 'CONFIRM_EPISODE' });
  expect(blocked.phase).toBe('result'); // no-op: no reason yet
  expect(blocked.episodes).toHaveLength(0);

  s = reducer(s, { type: 'PICK_FAIL_REASON', reason: 'Grasp missed' });
  const confirmed = reducer(s, { type: 'CONFIRM_EPISODE' });
  expect(confirmed.phase).toBe('ready');
  expect(confirmed.episodes).toEqual([
    { index: 1, quality: 'good', taskResult: 'fail', runId: undefined, failReason: 'Grasp missed' },
  ]);
});

test('quality and task result are independent axes, not one merged bucket', () => {
  // A clean recording (no warning) whose TASK still failed: quality stays
  // 'good' — a failed task is not "bad data", it's still usable/labeled
  // (this is the P1 fix: task outcome must never collapse into a quality
  // "not usable" bucket).
  let s = createState();
  s = { ...s, phase: 'result', recWarning: false };
  s = reducer(s, { type: 'PICK_RESULT', result: 'fail' });
  s = reducer(s, { type: 'PICK_FAIL_REASON', reason: 'Object dropped' });
  s = reducer(s, { type: 'CONFIRM_EPISODE' });
  expect(s.episodes[0]).toEqual({
    index: 1,
    quality: 'good',
    taskResult: 'fail',
    runId: undefined,
    failReason: 'Object dropped',
  });

  // Conversely, a review-flagged recording whose task SUCCEEDED: taskResult
  // stays 'ok', quality is 'review' — the two dimensions don't leak into
  // each other in either direction.
  let s2 = createState();
  s2 = { ...s2, phase: 'result', recWarning: true };
  s2 = reducer(s2, { type: 'PICK_RESULT', result: 'ok' });
  s2 = reducer(s2, { type: 'CONFIRM_EPISODE' });
  expect(s2.episodes[0]?.quality).toBe('review');
  expect(s2.episodes[0]?.taskResult).toBe('ok');
});

test('recording the 30th episode completes the batch', () => {
  let s = createState();
  s = {
    ...s,
    episodes: Array.from({ length: EPISODES_PER_BATCH - 1 }, (_, i) => ({
      index: i + 1,
      quality: 'good' as const,
      taskResult: 'ok' as const,
    })),
  };
  s = { ...s, phase: 'result' };
  s = reducer(s, { type: 'PICK_RESULT', result: 'ok' });
  s = reducer(s, { type: 'CONFIRM_EPISODE' });
  expect(s.episodes).toHaveLength(EPISODES_PER_BATCH);
  expect(s.phase).toBe('completed');
});

test('end-batch-early requires a reason, then moves to ended', () => {
  let s = createState();
  const blocked = reducer(s, { type: 'CONFIRM_END_BATCH' });
  expect(blocked.phase).toBe('ready'); // no-op: no reason picked

  s = reducer(s, { type: 'PICK_END_REASON', reason: 'Work time over' });
  s = reducer(s, { type: 'CONFIRM_END_BATCH' });
  expect(s.phase).toBe('ended');
});

test('START_NEXT_BATCH resets episodes and bumps the batch number from ended or completed', () => {
  let s = createState();
  s = { ...s, phase: 'ended', episodes: [{ index: 1, quality: 'good', taskResult: 'ok' }], batchNum: 1 };
  s = reducer(s, { type: 'START_NEXT_BATCH' });
  expect(s.phase).toBe('ready');
  expect(s.episodes).toEqual([]);
  expect(s.batchNum).toBe(2);
});

test('CANCEL_ARMING only applies while arming', () => {
  const ready = createState();
  expect(reducer(ready, { type: 'CANCEL_ARMING' }).phase).toBe('ready');

  const arming = reducer(ready, { type: 'START_REQUESTED' });
  expect(reducer(arming, { type: 'CANCEL_ARMING' }).phase).toBe('ready');
});

test('PAUSE_BATCH / RESUME_BATCH only apply from ready / paused respectively', () => {
  const ready = createState();
  const paused = reducer(ready, { type: 'PAUSE_BATCH' });
  expect(paused.phase).toBe('paused');
  // Can't pause again from a non-ready phase.
  const recording = reducer(reducer(ready, { type: 'START_REQUESTED' }), {
    type: 'START_SUCCEEDED',
    runId: null,
  });
  expect(reducer(recording, { type: 'PAUSE_BATCH' }).phase).toBe('recording');
  expect(reducer(paused, { type: 'RESUME_BATCH' }).phase).toBe('ready');
});

// ---------------------------------------------------------------------------
// Hook-level: real start/stop API wiring.
// ---------------------------------------------------------------------------

function wrapper({ children }: { children: ReactNode }) {
  const client = makeTestClient();
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  setApiBase('/api/v1');
  useUiStore.setState({ activeTab: '' });
});
afterEach(() => vi.restoreAllMocks());

test('startRecording() calls /record/start and only then moves to recording', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/record/start')) {
      return Promise.resolve(jsonResponse({ run_id: 'run_42', state: 'recording' }));
    }
    return Promise.resolve(jsonResponse({}));
  });

  const { result } = renderHook(() => useBatchMachine({ recordTopics: 'all' }), { wrapper });
  expect(result.current.phase).toBe('ready');

  act(() => result.current.startRecording());
  expect(result.current.phase).toBe('arming');

  await waitFor(() => expect(result.current.phase).toBe('recording'));
});

// The recorder can reject a start with HTTP 200 + state: "failed" (the row is
// kept as an audit trail) — this must surface as an error and stay in ready,
// never silently or incorrectly flip to recording.
test('a rejected start (200 + state=failed) reverts to ready with a banner, not recording', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/record/start')) {
      return Promise.resolve(
        jsonResponse({
          run_id: 'run_43',
          state: 'failed',
          error: { code: 'NO_TOPICS', message: 'no matching topics' },
        }),
      );
    }
    return Promise.resolve(jsonResponse({}));
  });

  const { result } = renderHook(() => useBatchMachine({ recordTopics: 'all' }), { wrapper });
  act(() => result.current.startRecording());
  expect(result.current.phase).toBe('arming');

  await waitFor(() => expect(result.current.phase).toBe('ready'));
  expect(result.current.startError).toContain('NO_TOPICS');
});

test('a network failure on start reverts to ready with an error banner', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/record/start')) return Promise.reject(new Error('network down'));
    return Promise.resolve(jsonResponse({}));
  });

  const { result } = renderHook(() => useBatchMachine({ recordTopics: 'all' }), { wrapper });
  act(() => result.current.startRecording());
  await waitFor(() => expect(result.current.phase).toBe('ready'));
  expect(result.current.startError).toContain('network down');
});

test('stopRecording() optimistically moves to saving and calls /record/stop', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/record/start')) {
      return Promise.resolve(jsonResponse({ run_id: 'run_1', state: 'recording' }));
    }
    if (url.includes('/record/stop')) {
      return Promise.resolve(jsonResponse({ run_id: 'run_1', state: 'completed' }));
    }
    return Promise.resolve(jsonResponse({}));
  });

  const { result } = renderHook(() => useBatchMachine({ recordTopics: 'all' }), { wrapper });
  act(() => result.current.startRecording());
  await waitFor(() => expect(result.current.phase).toBe('recording'));

  act(() => result.current.stopRecording());
  expect(result.current.phase).toBe('saving');
  await waitFor(() =>
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/record/stop'))).toBe(true),
  );
});
