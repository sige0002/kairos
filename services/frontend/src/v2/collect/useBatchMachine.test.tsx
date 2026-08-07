import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';
import { setApiBase } from '../../api/client';
import { makeTestClient, jsonResponse } from '../../test/renderWithClient';
import { useUiStore } from '../../store/uiStore';
import { isDestructiveFailure } from '../captures/errors';
import {
  batchMachineReducer as reducer,
  collectReviewStatus,
  createBatchMachineState as createState,
  useBatchMachine,
  __resetBatchStore,
  __setStopFloorMs,
  __resetStopFloorMs,
  __setStopConfirmMs,
  __rehydrateBatchStore,
  EPISODES_PER_BATCH,
} from './useBatchMachine';

const BATCH_STORAGE_KEY = 'kairos.collect.batch';

/**
 * A `Capture` body, as /record/start, /record/stop and GET /captures/{id} all
 * return one. `run_id` rides along because it is the name the operator reads on
 * disk (§1) — every key in these tests is the capture_id.
 */
function captureBody(captureId: string, extra: Record<string, unknown> = {}) {
  return {
    capture_id: captureId,
    run_id: `run_${captureId}`,
    state: 'recording',
    review_status: 'pending',
    review_revision: 0,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Pure reducer transitions — no React needed.
// ---------------------------------------------------------------------------

test('ready -> arming -> recording on a successful start', () => {
  let s = createState();
  expect(s.phase).toBe('ready');
  s = reducer(s, { type: 'START_REQUESTED' });
  expect(s.phase).toBe('arming');
  s = reducer(s, { type: 'START_SUCCEEDED', captureId: 'cap_1', runLabel: 'run_1' });
  expect(s.phase).toBe('recording');
  // The capture is what every later call keys on; the run_id is display text
  // that rides along beside it (§1).
  expect(s.currentCaptureId).toBe('cap_1');
  expect(s.currentRunLabel).toBe('run_1');
  // A capture the recorder just minted has never been reviewed, so the first
  // save's compare-and-swap token is 0 (§4.1).
  expect(s.currentReviewRevision).toBe(0);
});

test('a failed start returns to ready with an error, never reaching recording', () => {
  let s = createState();
  s = reducer(s, { type: 'START_REQUESTED' });
  s = reducer(s, { type: 'START_FAILED', error: { code: null, message: 'boom' } });
  expect(s.phase).toBe('ready');
  expect(s.startError?.message).toBe('boom');
});

test('recording -> saving -> quickcheck -> result (Success pre-selected)', () => {
  let s = createState();
  s = reducer(s, { type: 'START_REQUESTED' });
  s = reducer(s, { type: 'START_SUCCEEDED', captureId: null, runLabel: null });
  s = reducer(s, { type: 'STOP_REQUESTED' });
  expect(s.phase).toBe('saving');
  s = reducer(s, { type: 'SAVED' });
  expect(s.phase).toBe('quickcheck');
  s = reducer(s, { type: 'QUICK_CHECK_DONE' });
  expect(s.phase).toBe('result');
  // Success is pre-selected on entry so the happy path is one primary action.
  expect(s.pendingTask).toBe('ok');
});

// A stop that fails stays in SAVING (never snaps back to recording or forces the
// flow forward); the error is surfaced and cleared on retry.
test('STOP_FAILED stays in saving with an error; RETRY_STOP clears it', () => {
  let s = createState();
  s = reducer(s, { type: 'START_REQUESTED' });
  s = reducer(s, { type: 'START_SUCCEEDED', captureId: 'cap_1', runLabel: 'run_1' });
  s = reducer(s, { type: 'STOP_REQUESTED' });
  expect(s.phase).toBe('saving');
  s = reducer(s, { type: 'STOP_FAILED', error: { code: 'io', message: 'disk busy' } });
  expect(s.phase).toBe('saving');
  expect(s.stopError?.message).toBe('disk busy');
  s = reducer(s, { type: 'RETRY_STOP' });
  expect(s.phase).toBe('saving');
  expect(s.stopError).toBeNull();
});

// Failure-reason requirement: confirming a Failure result without a reason is
// a no-op; picking one unblocks it.
test('CONFIRM_EPISODE requires a fail reason when the result is Failure', () => {
  let s = createState();
  s = { ...s, phase: 'result' };
  s = reducer(s, { type: 'PICK_RESULT', result: 'fail' });
  expect(s.pendingTask).toBe('fail');

  const blocked = reducer(s, { type: 'CONFIRM_EPISODE', quality: 'good' });
  expect(blocked.phase).toBe('result'); // no-op: no reason yet
  expect(blocked.episodes).toHaveLength(0);

  s = reducer(s, { type: 'PICK_FAIL_REASON', reason: 'Grasp missed' });
  const confirmed = reducer(s, { type: 'CONFIRM_EPISODE', quality: 'good' });
  expect(confirmed.phase).toBe('ready');
  expect(confirmed.episodes).toEqual([
    {
      index: 1,
      quality: 'good',
      taskResult: 'fail',
      captureId: undefined,
      failReason: 'Grasp missed',
    },
  ]);
});

test('quality and task result are independent axes, not one merged bucket', () => {
  // A good-quality recording whose TASK still failed: quality stays 'good' — a
  // failed task is not "bad data", it's still usable/labeled (this is the P1
  // fix: task outcome must never collapse into a quality "not usable" bucket).
  // Quality is decided by the hook and passed into CONFIRM_EPISODE.
  let s = createState();
  s = { ...s, phase: 'result' };
  s = reducer(s, { type: 'PICK_RESULT', result: 'fail' });
  s = reducer(s, { type: 'PICK_FAIL_REASON', reason: 'Object dropped' });
  s = reducer(s, { type: 'CONFIRM_EPISODE', quality: 'good' });
  expect(s.episodes[0]).toEqual({
    index: 1,
    quality: 'good',
    taskResult: 'fail',
    captureId: undefined,
    failReason: 'Object dropped',
  });

  // Conversely, a review-flagged recording whose task SUCCEEDED: taskResult
  // stays 'ok', quality is 'review' — the two dimensions don't leak into
  // each other in either direction.
  let s2 = createState();
  s2 = { ...s2, phase: 'result' };
  s2 = reducer(s2, { type: 'PICK_RESULT', result: 'ok' });
  s2 = reducer(s2, { type: 'CONFIRM_EPISODE', quality: 'review' });
  expect(s2.episodes[0]?.quality).toBe('review');
  expect(s2.episodes[0]?.taskResult).toBe('ok');
});

// SET_QUALITY records the operator override (only valid in the result phase).
test('SET_QUALITY sets the override in the result phase and is a no-op elsewhere', () => {
  let s = createState();
  expect(
    reducer(s, { type: 'SET_QUALITY', quality: 'notusable' }).qualityOverride,
  ).toBeNull();
  s = { ...s, phase: 'result' };
  s = reducer(s, { type: 'SET_QUALITY', quality: 'notusable' });
  expect(s.qualityOverride).toBe('notusable');
  // Confirming clears the override for the next episode.
  s = reducer(s, { type: 'PICK_RESULT', result: 'ok' });
  s = reducer(s, { type: 'CONFIRM_EPISODE', quality: 'review' });
  expect(s.qualityOverride).toBeNull();
});

// A confirmed episode remembers WHICH capture it labels — the strip, the
// phantom-batch reconcile and the server restore all match on that id.
test('CONFIRM_EPISODE records the capture the episode labels', () => {
  let s = createState();
  s = { ...s, phase: 'result', pendingTask: 'ok', currentCaptureId: 'cap_9' };
  s = reducer(s, { type: 'CONFIRM_EPISODE', quality: 'good' });
  expect(s.episodes[0]).toMatchObject({ index: 1, captureId: 'cap_9' });
  // The take is done: the next one starts from a clean compare-and-swap base.
  expect(s.currentCaptureId).toBeNull();
  expect(s.currentReviewRevision).toBe(0);
});

// After a refused save the operator's typed values stay put; only the
// compare-and-swap token is refreshed, so a re-apply is checked against what is
// actually stored (§4.1 — never a merge).
test('SET_REVIEW_BASE adopts a refetched revision without touching the edit', () => {
  const s0 = {
    ...createState(),
    phase: 'result' as const,
    pendingTask: 'fail' as const,
    failReason: 'Grasp missed',
    currentCaptureId: 'cap_9',
    currentReviewRevision: 0,
  };
  const s = reducer(s0, { type: 'SET_REVIEW_BASE', revision: 3 });
  expect(s.currentReviewRevision).toBe(3);
  expect(s.pendingTask).toBe('fail');
  expect(s.failReason).toBe('Grasp missed');
  expect(s.phase).toBe('result');
  // An unchanged revision is a no-op (same state reference).
  expect(reducer(s, { type: 'SET_REVIEW_BASE', revision: 3 })).toBe(s);
});

test('SET_TARGET re-derives completion at rest and is clamped', () => {
  let s = createState();
  expect(s.targetEpisodes).toBe(EPISODES_PER_BATCH);
  // Lowering the target to what's already recorded completes the batch …
  s = { ...s, recordedCount: 10 };
  s = reducer(s, { type: 'SET_TARGET', target: 10 });
  expect(s.targetEpisodes).toBe(10);
  expect(s.phase).toBe('completed');
  // … and raising it re-opens it.
  s = reducer(s, { type: 'SET_TARGET', target: 12 });
  expect(s.phase).toBe('ready');
  // Clamped to >= 1; never disturbs an active recording phase.
  s = reducer(s, { type: 'SET_TARGET', target: 0 });
  expect(s.targetEpisodes).toBe(1);
  const rec = reducer(
    { ...createState(), phase: 'recording' },
    { type: 'SET_TARGET', target: 5 },
  );
  expect(rec.phase).toBe('recording');
  expect(rec.targetEpisodes).toBe(5);
});

test('recording the 30th episode completes the batch', () => {
  let s = createState();
  s = {
    ...s,
    // Counts are driven by the monotone recordedCount, so seed it alongside the
    // 29 recorded episodes.
    recordedCount: EPISODES_PER_BATCH - 1,
    episodes: Array.from({ length: EPISODES_PER_BATCH - 1 }, (_, i) => ({
      index: i + 1,
      quality: 'good' as const,
      taskResult: 'ok' as const,
    })),
  };
  s = { ...s, phase: 'result' };
  s = reducer(s, { type: 'PICK_RESULT', result: 'ok' });
  s = reducer(s, { type: 'CONFIRM_EPISODE', quality: 'good' });
  expect(s.episodes).toHaveLength(EPISODES_PER_BATCH);
  expect(s.recordedCount).toBe(EPISODES_PER_BATCH);
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

test('START_NEXT_BATCH resets episodes and clears the batch number (server re-assigns)', () => {
  let s = createState();
  s = {
    ...s,
    phase: 'ended',
    episodes: [{ index: 1, quality: 'good', taskResult: 'ok' }],
    batchSeq: 5,
  };
  s = reducer(s, { type: 'START_NEXT_BATCH' });
  expect(s.phase).toBe('ready');
  expect(s.episodes).toEqual([]);
  // No local +1: the next batch's number is assigned server-side on first record.
  expect(s.batchSeq).toBeNull();
  expect(s.batchId).toBeNull();
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
  const recording = reducer(reducer(ready, { type: 'START_REQUESTED' }), { type: 'START_SUCCEEDED', captureId: null, runLabel: null });
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
  // These tests are not about the Stop floor; they stop immediately after
  // starting, which the shipped 1s guard would (correctly) refuse.
  __setStopFloorMs(0);
  // Nor about the flush-confirmation budget: a zero budget makes the
  // post-stop poll a single check, so a mock that never reports terminal
  // is refused immediately instead of after the shipped ~70s escalation
  // window. The flush-success test below sets its own budget.
  __setStopConfirmMs(0, 1);
  // The batch machine now lives in a module-level store (so it survives a
  // tab-switch unmount); reset it — and its localStorage mirror — between hook
  // tests so state can't leak from one test into the next.
  __resetBatchStore();
  // Reset the shared record-picker store so selection-resolution tests don't
  // leak customized state into each other.
  useUiStore.setState({
    activeTab: '',
    recordOperator: '',
    recordSelected: new Set<string>(),
    recordCustomized: false,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  // No-op for the ~84 tests on the real clock; unpins the system time for the
  // prediction tests that set it (restoreAllMocks does not restore timers).
  vi.useRealTimers();
});

test('startRecording() calls /record/start and only then moves to recording', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/record/start')) {
      return Promise.resolve(jsonResponse(captureBody('cap_42')));
    }
    return Promise.resolve(jsonResponse({}));
  });

  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  expect(result.current.phase).toBe('ready');

  act(() => result.current.startRecording());
  expect(result.current.phase).toBe('arming');

  await waitFor(() => expect(result.current.phase).toBe('recording'));
});

// M2: two clicks (or two presses of the R shortcut) landing in the SAME tick
// both read `state.phase` from a closure that does not update until the next
// render, so both passed the ready check and both called /record/start. The
// second recording was whatever few milliseconds the recorder managed before
// the first stop caught up — and it arrived in Review looking like a real take.
test('two starts in one tick create exactly one recording', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/record/start')) {
      return Promise.resolve(jsonResponse(captureBody('cap_44')));
    }
    return Promise.resolve(jsonResponse({}));
  });

  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  expect(result.current.phase).toBe('ready');

  // Both calls inside ONE act: no render happens between them, so the phase
  // guard alone cannot tell them apart.
  act(() => {
    result.current.startRecording();
    result.current.startRecording();
  });

  await waitFor(() => expect(result.current.phase).toBe('recording'));
  const starts = fetchSpy.mock.calls.filter((c) =>
    String(c[0]).includes('/record/start'),
  );
  expect(starts).toHaveLength(1);
});

// M2 (qa-ui p07): a real double-click's second press lands on the Stop button
// that replaced Start at the same coordinates — start at T+0, its own stop at
// T+86ms, an 87ms bag. The shipped floor is used here deliberately, not the
// test seam: this test exists to prove the floor a real operator gets.
test('a stop within the floor is refused, so a double-click cannot end its own take', async () => {
  __resetStopFloorMs();
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/record/start')) {
      return Promise.resolve(jsonResponse(captureBody('cap_dbl')));
    }
    return Promise.resolve(jsonResponse({}));
  });

  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  act(() => result.current.startRecording());
  await waitFor(() => expect(result.current.phase).toBe('recording'));

  // The instant the recording card appears, Stop is refused and says why.
  expect(result.current.canStop).toBe(false);
  expect(result.current.stopBlockedReason).toBe('floor');

  // The second half of the double-click, arriving milliseconds later.
  act(() => result.current.stopRecording());
  expect(result.current.phase).toBe('recording');
  expect(
    fetchSpy.mock.calls.filter((c) => String(c[0]).includes('/record/stop')),
  ).toHaveLength(0);

  __setStopFloorMs(0);
});

// The floor must not become a trap: a deliberate stop still works.
test('once the floor has passed the stop goes through normally', async () => {
  __setStopFloorMs(0);
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/record/start')) {
      return Promise.resolve(jsonResponse(captureBody('cap_ok')));
    }
    if (url.includes('/record/stop')) {
      return Promise.resolve(jsonResponse(captureBody('cap_ok', { state: 'completed' })));
    }
    return Promise.resolve(jsonResponse({}));
  });

  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  act(() => result.current.startRecording());
  await waitFor(() => expect(result.current.phase).toBe('recording'));
  expect(result.current.canStop).toBe(true);

  act(() => result.current.stopRecording());
  expect(result.current.phase).toBe('saving');
});

// The recorder can reject a start with HTTP 200 + state: "failed" (the row is
// kept as an audit trail) — this must surface as an error and stay in ready,
// never silently or incorrectly flip to recording.
test('a rejected start (200 + state=failed) reverts to ready with a banner, not recording', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/record/start')) {
      return Promise.resolve(
        jsonResponse(
          captureBody('cap_43', {
            state: 'failed',
            error: { code: 'NO_TOPICS', message: 'no matching topics' },
          }),
        ),
      );
    }
    return Promise.resolve(jsonResponse({}));
  });

  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  act(() => result.current.startRecording());
  expect(result.current.phase).toBe('arming');

  await waitFor(() => expect(result.current.phase).toBe('ready'));
  expect(result.current.startError?.code).toBe('NO_TOPICS');
  expect(result.current.startError?.message).toBe('no matching topics');
});

test('a network failure on start reverts to ready with an error banner', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/record/start')) return Promise.reject(new Error('network down'));
    return Promise.resolve(jsonResponse({}));
  });

  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  act(() => result.current.startRecording());
  await waitFor(() => expect(result.current.phase).toBe('ready'));
  expect(result.current.startError?.message).toContain('network down');
  // A transport failure (no code) maps to the unreachable-recorder friendly code.
  expect(result.current.startError?.code).toBe('recorder_unreachable');
});

test('stopRecording() optimistically moves to saving and calls /record/stop', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/record/start')) {
      return Promise.resolve(jsonResponse(captureBody('cap_1')));
    }
    if (url.includes('/record/stop')) {
      return Promise.resolve(jsonResponse(captureBody('cap_1', { state: 'completed' })));
    }
    return Promise.resolve(jsonResponse({}));
  });

  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  act(() => result.current.startRecording());
  await waitFor(() => expect(result.current.phase).toBe('recording'));

  act(() => result.current.stopRecording());
  expect(result.current.phase).toBe('saving');
  await waitFor(() =>
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/record/stop'))).toBe(
      true,
    ),
  );
});

// Regression: /record/stop is idempotent and answers with the last run when it
// finds nothing active, so a 200 alone does not prove the recorder stopped. If
// it is still recording we must NOT advance to labelling a take that is still
// being written — stay on SAVING with the Retry-stop button.
test('a stop the recorder did not honour keeps the screen on saving', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/record/start')) {
      return Promise.resolve(jsonResponse(captureBody('cap_1')));
    }
    if (url.includes('/record/stop')) {
      // 200 with the last capture — the idempotent no-op answer.
      return Promise.resolve(jsonResponse(captureBody('cap_1', { state: 'completed' })));
    }
    if (url.includes('/record/status')) {
      // ...but the recorder is still going, and still names our capture live.
      return Promise.resolve(
        jsonResponse({
          capture_id: 'cap_1',
          run_id: 'run_cap_1',
          state: 'recording',
          live_capture_ids: ['cap_1'],
        }),
      );
    }
    return Promise.resolve(jsonResponse({}));
  });

  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  act(() => result.current.startRecording());
  await waitFor(() => expect(result.current.phase).toBe('recording'));

  act(() => result.current.stopRecording());
  await waitFor(() => expect(result.current.stopError).not.toBeNull());
  expect(result.current.phase).toBe('saving');
  expect(result.current.stopError?.code).toBe('stop_not_confirmed');
});

// The definitive liveness signal is `live_capture_ids` (§10). A recorder that
// reports a benign state but still names our capture live has NOT stopped, and
// walking on to labelling a bag that is still being written is exactly the
// failure this confirmation exists to prevent.
test('a stop is refused while live_capture_ids still names our capture', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/record/start'))
      return Promise.resolve(jsonResponse(captureBody('cap_1')));
    if (url.includes('/record/stop'))
      return Promise.resolve(jsonResponse(captureBody('cap_1', { state: 'completed' })));
    if (url.includes('/record/status'))
      return Promise.resolve(
        jsonResponse({
          capture_id: 'cap_1',
          run_id: 'run_cap_1',
          state: 'completed',
          live_capture_ids: ['cap_1'],
        }),
      );
    return Promise.resolve(jsonResponse({}));
  });

  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  act(() => result.current.startRecording());
  await waitFor(() => expect(result.current.phase).toBe('recording'));

  act(() => result.current.stopRecording());
  await waitFor(() => expect(result.current.stopError?.code).toBe('stop_not_confirmed'));
  expect(result.current.phase).toBe('saving');
});

// The UX fix (2026-08-07): a recorder that is merely FLUSHING is not a failed
// stop. rosbag2 drains its cache for seconds after /record/stop returns, and
// that used to surface as stop_not_confirmed on the very first status check.
// The confirmation now POLLS until the recorder reports terminal and only
// errors past the escalation budget — so a flush that finishes inside it
// advances to QUICK CHECK with no error ever shown.
test('a stop that confirms on a later poll (flush in progress) is not an error', async () => {
  // Real budget semantics, fast cadence so several polls fit in the test.
  __setStopConfirmMs(5000, 5);
  let stopCalled = false;
  let postStopStatusCalls = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/record/start'))
      return Promise.resolve(jsonResponse(captureBody('cap_1')));
    if (url.includes('/record/stop')) {
      stopCalled = true;
      return Promise.resolve(jsonResponse(captureBody('cap_1', { state: 'completed' })));
    }
    if (url.includes('/record/status')) {
      if (!stopCalled) return Promise.resolve(jsonResponse({}));
      postStopStatusCalls += 1;
      if (postStopStatusCalls <= 2) {
        // Still draining the cache to disk — normal progress, not a failure.
        return Promise.resolve(
          jsonResponse({
            capture_id: 'cap_1',
            run_id: 'run_cap_1',
            state: 'stopping',
            live_capture_ids: ['cap_1'],
          }),
        );
      }
      // The flush finished: terminal state, nothing live.
      return Promise.resolve(
        jsonResponse({
          capture_id: 'cap_1',
          run_id: 'run_cap_1',
          state: 'completed',
          live_capture_ids: [],
        }),
      );
    }
    return Promise.resolve(jsonResponse({}));
  });

  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  act(() => result.current.startRecording());
  await waitFor(() => expect(result.current.phase).toBe('recording'));

  act(() => result.current.stopRecording());
  expect(result.current.phase).toBe('saving');
  await waitFor(() => expect(result.current.phase).toBe('quickcheck'));
  expect(result.current.stopError).toBeNull();
});

// ---------------------------------------------------------------------------
// Real recorder status: arming (matched/missing) + integrity (drop/fail).
// ---------------------------------------------------------------------------

test('/record/status arming (matched/missing) surfaces on machine.arming', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/record/status')) {
      return Promise.resolve(
        jsonResponse({
          capture_id: 'cap_7',
          run_id: 'run_7',
          state: 'recording',
          live_capture_ids: ['cap_7'],
          arming: {
            active: false,
            matched_topics: ['/a', '/b', '/c'],
            missing_topics: ['/x', '/y'],
          },
        }),
      );
    }
    return Promise.resolve(jsonResponse({}));
  });

  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  await waitFor(() => expect(result.current.arming).not.toBeNull());
  expect(result.current.arming?.matched_topics).toHaveLength(3);
  expect(result.current.arming?.missing_topics).toEqual(['/x', '/y']);
});

test('a dropped-integrity capture surfaces on machine.integrity + droppedMessages', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/record/start')) {
      return Promise.resolve(jsonResponse(captureBody('cap_1')));
    }
    if (url.includes('/record/status')) {
      return Promise.resolve(
        jsonResponse({
          capture_id: 'cap_1',
          run_id: 'run_cap_1',
          state: 'completed',
          live_capture_ids: [],
          integrity: 'dropped',
          dropped_messages: 1234,
        }),
      );
    }
    return Promise.resolve(jsonResponse({}));
  });

  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  act(() => result.current.startRecording());
  await waitFor(() => expect(result.current.phase).toBe('recording'));
  await waitFor(() => expect(result.current.integrity).toBe('dropped'));
  expect(result.current.droppedMessages).toBe(1234);
});

// Gating: an integrity report for a *different* capture must never leak into
// the current episode's result. Before any start (currentCaptureId null) the
// status is ungated, so it reads through; once a start binds cap_1, a report
// naming another capture is dropped.
test('integrity is gated to the current capture — a mismatched capture_id is dropped after start', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/record/start')) {
      return Promise.resolve(jsonResponse(captureBody('cap_1')));
    }
    if (url.includes('/record/status')) {
      return Promise.resolve(
        jsonResponse({
          capture_id: 'cap_OTHER',
          run_id: 'run_other',
          state: 'completed',
          live_capture_ids: [],
          integrity: 'dropped',
          dropped_messages: 9,
        }),
      );
    }
    return Promise.resolve(jsonResponse({}));
  });

  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  await waitFor(() => expect(result.current.integrity).toBe('dropped'));
  act(() => result.current.startRecording());
  await waitFor(() => expect(result.current.phase).toBe('recording'));
  await waitFor(() => expect(result.current.integrity).toBeNull());
});

// ---------------------------------------------------------------------------
// operator (Task 2) + selection resolution (Task 3) + real Discard (Task 1).
// ---------------------------------------------------------------------------

function startFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/record/start')) {
      return Promise.resolve(jsonResponse(captureBody('cap_1')));
    }
    return Promise.resolve(jsonResponse({}));
  });
}

test('startRecording sends operator (trimmed) + configured topics', async () => {
  const fetchMock = startFetch();
  useUiStore.setState({ recordOperator: '  yuki  ' });

  const { result } = renderHook(
    () => useBatchMachine({ defaultTopics: ['/a', '/b'] }),
    { wrapper },
  );
  act(() => result.current.startRecording());
  await waitFor(() => expect(result.current.phase).toBe('recording'));

  const call = fetchMock.mock.calls.find(([u]) => String(u).includes('/record/start'));
  const body = JSON.parse(String((call![1] as RequestInit).body));
  expect(body.operator).toBe('yuki');
  expect(body.topics).toEqual(['/a', '/b']);
});

test('startRecording omits operator when the store value is blank, defaults to all topics', async () => {
  const fetchMock = startFetch();
  // recordOperator stays '' (reset in beforeEach).
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  act(() => result.current.startRecording());
  await waitFor(() => expect(result.current.phase).toBe('recording'));

  const call = fetchMock.mock.calls.find(([u]) => String(u).includes('/record/start'));
  const body = JSON.parse(String((call![1] as RequestInit).body));
  expect('operator' in body).toBe(false);
  expect(body.topics).toBe('all');
});

test('selection resolution: customized set → explicit topics; empty customized set disables Start', () => {
  useUiStore.setState({
    recordCustomized: true,
    recordSelected: new Set(['/x', '/y']),
  });
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: ['/a'] }), {
    wrapper,
  });
  expect(result.current.selection).toEqual({
    topics: ['/x', '/y'],
    count: 2,
    customized: true,
  });
  expect(result.current.noSelection).toBe(false);

  // Clearing every topic (customized empty set) disables Start.
  act(() => useUiStore.setState({ recordSelected: new Set<string>() }));
  expect(result.current.selection.count).toBe(0);
  expect(result.current.noSelection).toBe(true);
});

test('selection resolution: configured defaults, then all when neither customized nor configured', () => {
  const configured = renderHook(
    () => useBatchMachine({ defaultTopics: ['/a', '/b', '/c'] }),
    {
      wrapper,
    },
  );
  expect(configured.result.current.selection).toEqual({
    topics: ['/a', '/b', '/c'],
    count: 3,
    customized: false,
  });

  const all = renderHook(() => useBatchMachine({ defaultTopics: [] }), { wrapper });
  expect(all.result.current.selection).toEqual({
    topics: 'all',
    count: 0,
    customized: false,
  });
});

test('startRecording is a no-op when the customized selection is empty', async () => {
  const fetchMock = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(() => Promise.resolve(jsonResponse({})));
  useUiStore.setState({ recordCustomized: true, recordSelected: new Set<string>() });

  const { result } = renderHook(() => useBatchMachine({ defaultTopics: ['/a'] }), {
    wrapper,
  });
  expect(result.current.noSelection).toBe(true);
  act(() => result.current.startRecording());
  expect(result.current.phase).toBe('ready');
  await Promise.resolve();
  expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/record/start'))).toBe(
    false,
  );
});

// Discard (§7): a busy capture is refused by name — the lease holder is what
// the operator has to wait for, and "try again later" without it is not
// actionable (§7.1). A refused discard keeps the take on the result panel.
test('Discard: a capture_busy refusal names the lease holder and keeps the take', async () => {
  let busy = true;
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.includes('/record/status')) {
      return Promise.resolve(
        jsonResponse({
          capture_id: 'cap_9',
          run_id: 'run_cap_9',
          state: 'completed',
          live_capture_ids: [],
          integrity: 'ok',
        }),
      );
    }
    if (url.includes('/record/start'))
      return Promise.resolve(jsonResponse(captureBody('cap_9')));
    if (url.includes('/record/stop'))
      return Promise.resolve(jsonResponse(captureBody('cap_9', { state: 'completed' })));
    if (url.includes('/captures/cap_9/delete') && method === 'POST') {
      return busy
        ? Promise.resolve(
            jsonResponse(
              {
                error: {
                  code: 'capture_busy',
                  message: 'A job holds this capture.',
                  details: { lease_owner: 'digest' },
                },
              },
              409,
            ),
          )
        : Promise.resolve(jsonResponse(captureBody('cap_9', { state: 'discarded' })));
    }
    if (url.includes('/captures/cap_9'))
      return Promise.resolve(
        jsonResponse(captureBody('cap_9', { state: 'completed', bytes: 2048 })),
      );
    if (url.includes('/captures'))
      return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
    return Promise.resolve(jsonResponse({}));
  });

  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  act(() => result.current.startRecording());
  await waitFor(() => expect(result.current.phase).toBe('recording'));
  act(() => result.current.stopRecording());
  await waitFor(() => expect(result.current.phase).toBe('result'), { timeout: 4000 });

  // One click, no dialog: the press itself runs the discard.
  await act(async () => {
    result.current.discardEpisode();
  });
  await waitFor(() =>
    expect(result.current.episodeDiscard.failures).toHaveLength(1),
  );
  // Refused: the take survives on the result panel, nothing opened, and the
  // failure names the job the operator is waiting on.
  expect(result.current.episodeDiscard.kind).toBeNull();
  expect(result.current.phase).toBe('result');
  expect(result.current.episodeDiscard.failures[0]?.error).toContain('digest');

  // Retry is the same press. A succeeding discard POSTs {kind:'discard'} with
  // the ledger-honest automatic reason and re-arms for a retake.
  busy = false;
  await act(async () => {
    result.current.discardEpisode();
  });
  await waitFor(() => expect(result.current.phase).toBe('ready'));
  expect(result.current.episodes).toHaveLength(0);
  const del = fetchMock.mock.calls
    .filter(
      ([u, i]) =>
        String(u).includes('/captures/cap_9/delete') && i?.method === 'POST',
    )
    .at(-1);
  expect(JSON.parse(String((del![1] as RequestInit).body))).toEqual({
    kind: 'discard',
    reason: 'Collect one-click discard (no reason asked)',
  });
});

// ---------------------------------------------------------------------------
// State survives a tab-switch unmount (module store) and a reload (localStorage).
// ---------------------------------------------------------------------------

/** Mock /record/start + /record/stop + /record/status for a given capture id
 *  (drives one episode). The status carries integrity 'ok' so QUICK CHECK
 *  advances on the real signal instead of the fallback timer. */
function recordFlowFetch(captureId: string) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.includes('/record/start')) {
      return Promise.resolve(jsonResponse(captureBody(captureId)));
    }
    if (url.includes('/record/stop')) {
      return Promise.resolve(
        jsonResponse(captureBody(captureId, { state: 'completed' })),
      );
    }
    if (url.includes('/record/status')) {
      return Promise.resolve(
        jsonResponse({
          capture_id: captureId,
          run_id: `run_${captureId}`,
          state: 'completed',
          live_capture_ids: [],
          integrity: 'ok',
        }),
      );
    }
    if (url.includes('/review') && method === 'PATCH') {
      return Promise.resolve(
        jsonResponse(captureBody(captureId, { state: 'completed', review_revision: 1 })),
      );
    }
    if (url.includes('/captures'))
      return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
    return Promise.resolve(jsonResponse({}));
  });
}

// (a) A confirmed episode must survive the hook unmounting and remounting — the
// exact tab-switch the bug wiped (episode count back to 0/30).
test('confirmed episodes survive an unmount/remount (tab switch)', async () => {
  recordFlowFetch('cap_1');
  const { result, unmount } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });

  act(() => result.current.startRecording());
  await waitFor(() => expect(result.current.phase).toBe('recording'));
  act(() => result.current.stopRecording());
  await waitFor(() => expect(result.current.phase).toBe('result'), { timeout: 4000 });
  act(() => result.current.pickSuccess());
  act(() => result.current.confirmEpisode());
  await waitFor(() => expect(result.current.stats.nRecorded).toBe(1));

  // Tab switch: the CollectScreen unmounts, then a fresh instance remounts.
  unmount();
  const remounted = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  expect(remounted.result.current.stats.nRecorded).toBe(1);
  expect(remounted.result.current.stats.epNext).toBe(2);
  expect(remounted.result.current.phase).toBe('ready');
});

// (d) The result phase and its capture are durable context — a mid-result-phase
// tab round-trip must keep both (so Discard / integrity gating still target the
// right capture on return).
test('the result phase and its capture survive an unmount/remount', async () => {
  recordFlowFetch('cap_9');
  const { result, unmount } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });

  act(() => result.current.startRecording());
  await waitFor(() => expect(result.current.phase).toBe('recording'));
  act(() => result.current.stopRecording());
  await waitFor(() => expect(result.current.phase).toBe('result'), { timeout: 4000 });
  // The run label is display text; the capture is what survives as the key.
  expect(result.current.currentRunLabel).toBe('run_cap_9');

  unmount();
  const remounted = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  expect(remounted.result.current.phase).toBe('result');
  expect(remounted.result.current.currentRunLabel).toBe('run_cap_9');
});

// (b) A reload restores the durable session context from localStorage.
test('a reload restores episodes, batchSeq and context from localStorage', () => {
  window.localStorage.setItem(
    BATCH_STORAGE_KEY,
    JSON.stringify({
      batchSeq: 3,
      episodes: [
        { index: 1, quality: 'good', taskResult: 'ok' },
        { index: 2, quality: 'review', taskResult: 'fail', failReason: 'Grasp missed' },
      ],
      project: 'Bin Picking',
      task: 'Bin to Tray',
      condition: 'Bin: full',
    }),
  );
  __rehydrateBatchStore();

  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  expect(result.current.batchSeq).toBe(3);
  expect(result.current.episodes).toHaveLength(2);
  expect(result.current.stats.nReview).toBe(1);
  expect(result.current.stats.nTaskFailed).toBe(1);
  expect(result.current.stats.epNext).toBe(3);
  expect(result.current.project).toBe('Bin Picking');
  expect(result.current.condition).toBe('Bin: full');
});

// (c) A volatile phase is never restored: a persisted mid-recording context
// resolves to the safe 'ready' baseline (with no invented run/result), while
// the durable episodes still come back.
test('a volatile phase is NOT restored on reload — recording resolves to ready', () => {
  const defaults = createState();
  window.localStorage.setItem(
    BATCH_STORAGE_KEY,
    JSON.stringify({
      batchNum: 1,
      episodes: [{ index: 1, quality: 'good', taskResult: 'ok' }],
      project: defaults.project,
      task: defaults.task,
      condition: defaults.condition,
      // A stale volatile phase/capture must be ignored on restore.
      phase: 'recording',
      currentCaptureId: 'cap_stale',
      elapsedMs: 4200,
    }),
  );
  __rehydrateBatchStore();

  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  expect(result.current.phase).toBe('ready');
  expect(result.current.elapsedMs).toBe(0);
  expect(result.current.currentRunLabel).toBeNull();
  expect(result.current.stats.nRecorded).toBe(1);
});

// ---------------------------------------------------------------------------
// Orchestrator API: batch create / review save / lifecycle PATCH / server
// restore. The review save is a compare-and-swap on the capture (§4.1) — there
// is no episodes resource and no browser-local mirror of it any more.
// ---------------------------------------------------------------------------

/** A batch as the server holds it. `captures` is what `GET /batches/{id}`
 *  serves; the LIST is a count and never carries it (E-27), which is exactly
 *  what `phase2Fetch` reproduces. */
interface BatchFixture extends Record<string, unknown> {
  batch_id: string;
  captures?: Record<string, unknown>[];
}

interface Phase2Opts {
  captureId?: string;
  batchId?: string;
  activeBatches?: BatchFixture[];
  /** HTTP status for `GET /batches/{id}` when the detail must be refused —
   *  the restore's only source of episodes, so its failure is its own case. */
  batchDetailStatus?: number;
  /** Status + body for `PATCH /captures/{id}/review` when it must be refused. */
  reviewFails?: { status: number; body: Record<string, unknown> };
  /** capture_ids the server's `GET /captures` list reports as still existing —
   *  used by the phantom-batch reconcile (a seeded local batch is real only
   *  when its captures are here). Defaults to none. */
  captures?: string[];
  /** Extra fields merged into the `GET /captures/{id}` body (the result-panel
   *  quick_check poll, F1) — e.g. `{ quick_check: { verdict: {...} } }`. */
  captureDetail?: Record<string, unknown>;
}

/** Mocks the record + batches + captures endpoints, capturing every request. */
function phase2Fetch(opts: Phase2Opts = {}) {
  const captureId = opts.captureId ?? 'cap_1';
  const batchId = opts.batchId ?? 'batch_x';
  const fixtures = opts.activeBatches ?? [];
  // The list item is the fixture MINUS its captures: the server's list serves a
  // count per batch, so a restore reading the list alone finds no episodes.
  const listItems = fixtures.map((fixture) => {
    const item: Record<string, unknown> = { ...fixture };
    delete item.captures;
    return item;
  });
  const calls: {
    url: string;
    method: string;
    body: Record<string, unknown> | undefined;
  }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: Record<string, unknown> | undefined;
    if (init?.body) {
      try {
        body = JSON.parse(String(init.body)) as Record<string, unknown>;
      } catch {
        body = undefined;
      }
    }
    calls.push({ url, method, body });
    if (url.includes('/batches') && method === 'POST') {
      return Promise.resolve(
        jsonResponse({ ...body, batch_id: batchId, status: 'active' }, 201),
      );
    }
    if (url.includes('/batches') && method === 'PATCH') {
      return Promise.resolve(
        jsonResponse({ batch_id: batchId, status: body?.status ?? 'active' }),
      );
    }
    // GET /batches/{id} — the detail, and the ONLY place a batch's captures
    // are served. Matched before the list so the two never collide.
    const batchDetail = /\/batches\/([^/?]+)$/.exec(url);
    if (method === 'GET' && batchDetail) {
      const id = decodeURIComponent(batchDetail[1]!);
      const fixture = fixtures.find((b) => b.batch_id === id);
      if (opts.batchDetailStatus || !fixture) {
        return Promise.resolve(
          jsonResponse(
            { error: { code: 'batch_not_found', message: `no batch ${id}` } },
            opts.batchDetailStatus ?? 404,
          ),
        );
      }
      const { captures: batchCaptures = [], ...batch } = fixture;
      return Promise.resolve(
        jsonResponse({
          ...batch,
          episode_count: batchCaptures.length,
          captures: batchCaptures.map((c) => ({
            state: 'completed',
            review_revision: 1,
            ...c,
          })),
        }),
      );
    }
    if (url.includes('/batches') && method === 'GET') {
      return Promise.resolve(jsonResponse({ items: listItems }));
    }
    if (url.includes('/review') && method === 'PATCH') {
      if (opts.reviewFails) {
        return Promise.resolve(
          jsonResponse(opts.reviewFails.body, opts.reviewFails.status),
        );
      }
      // The server echoes the saved review with the revision advanced by one.
      return Promise.resolve(
        jsonResponse(
          captureBody(captureId, { state: 'completed', review_revision: 1, ...body }),
        ),
      );
    }
    // GET /captures (the list) — the phantom reconcile and the unsaved-take scan.
    if (method === 'GET' && /\/captures(\?|$)/.test(url)) {
      const items = (opts.captures ?? []).map((cid) =>
        captureBody(cid, { state: 'completed', review_revision: 1 }),
      );
      return Promise.resolve(jsonResponse({ items, next_cursor: null }));
    }
    // GET /captures/{id} — the result-panel quick_check poll (F1) and the
    // capture the discard dialog states the size of.
    if (method === 'GET' && /\/captures\/[^/?]+/.test(url)) {
      return Promise.resolve(
        jsonResponse(
          captureBody(captureId, {
            state: 'completed',
            ...(opts.captureDetail ?? {}),
          }),
        ),
      );
    }
    if (url.includes('/record/status')) {
      return Promise.resolve(
        jsonResponse({
          capture_id: captureId,
          run_id: `run_${captureId}`,
          state: 'completed',
          live_capture_ids: [],
          integrity: 'ok',
        }),
      );
    }
    if (url.includes('/record/start')) {
      return Promise.resolve(jsonResponse(captureBody(captureId)));
    }
    if (url.includes('/record/stop')) {
      return Promise.resolve(
        jsonResponse(captureBody(captureId, { state: 'completed' })),
      );
    }
    return Promise.resolve(jsonResponse({}));
  });
  return { calls };
}

test('starting a recording creates a server batch with the plan context', async () => {
  useUiStore.setState({ recordOperator: 'yuki' });
  const { calls } = phase2Fetch();
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });

  act(() => result.current.startRecording());
  await waitFor(() => expect(result.current.phase).toBe('recording'));
  await waitFor(() =>
    expect(calls.some((c) => c.url.includes('/batches') && c.method === 'POST')).toBe(
      true,
    ),
  );
  const post = calls.find((c) => c.url.includes('/batches') && c.method === 'POST')!;
  expect(post.body).toMatchObject({
    project: 'Tabletop Manipulation',
    task: 'Pick and Place',
    operator: 'yuki',
    target_episodes: EPISODES_PER_BATCH,
  });
});

// M5: Coverage is read from the batch's `episodes_recorded`, which the server
// only moves on the FIRST review save for a capture (§4.1). Without an
// invalidation the figure sat on its own 30s refetch and silently disagreed
// with the strip the operator had just watched update.
test('a review save invalidates the batches the coverage figure is read from', async () => {
  phase2Fetch({ captureId: 'cap_cov', batchId: 'batch_cov' });
  const client = makeTestClient();
  const invalidated: unknown[] = [];
  const realInvalidate = client.invalidateQueries.bind(client);
  vi.spyOn(client, 'invalidateQueries').mockImplementation((filters) => {
    invalidated.push((filters as { queryKey?: unknown })?.queryKey);
    return realInvalidate(filters);
  });
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });

  act(() => result.current.startRecording());
  await waitFor(() => expect(result.current.phase).toBe('recording'));
  act(() => result.current.stopRecording());
  await waitFor(() => expect(result.current.phase).toBe('result'), { timeout: 4000 });
  act(() => result.current.confirmEpisode());
  await waitFor(() => expect(result.current.stats.nRecorded).toBe(1));

  // CoverageCard reads ['batches','coverage'], so invalidating ['batches']
  // reaches it by prefix — the figure refreshes with the strip instead of
  // waiting out its own 30-second interval.
  await waitFor(() =>
    expect(
      invalidated.some((k) => Array.isArray(k) && k[0] === 'batches'),
    ).toBe(true),
  );
});

test('saving PATCHes the capture review with the batch stamp and a CAS token', async () => {
  const { calls } = phase2Fetch({ captureId: 'cap_ep', batchId: 'batch_ep' });
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });

  act(() => result.current.startRecording());
  await waitFor(() => expect(result.current.phase).toBe('recording'));
  act(() => result.current.stopRecording());
  await waitFor(() => expect(result.current.phase).toBe('result'), { timeout: 4000 });
  act(() => result.current.pickFailure());
  act(() => result.current.pickFailReason('Object dropped'));
  act(() => result.current.confirmEpisode());
  await waitFor(() => expect(result.current.stats.nRecorded).toBe(1));

  const patch = calls.find(
    (c) => c.url.includes('/captures/cap_ep/review') && c.method === 'PATCH',
  )!;
  expect(patch).toBeTruthy();
  // The operator did NOT override quality, so the payload OMITS quality and
  // quality_source: the server derives them from the capture's settled
  // quick_check verdict, and claiming 'operator' provenance for a value nobody
  // chose would also freeze it against the later correction (§4.1).
  expect(patch.body).toMatchObject({
    base_revision: 0,
    batch_id: 'batch_ep',
    index_in_batch: 1,
    task_result: 'failure',
    failure_reason: 'Object dropped',
    review_status: 'pending',
  });
  expect(patch.body).not.toHaveProperty('quality');
  expect(patch.body).not.toHaveProperty('quality_source');
});

// §12: a refused save is stated, and nothing on screen claims it happened.
test('a 409 review_conflict is surfaced, the episode is not counted, and the CAS token is refreshed', async () => {
  phase2Fetch({
    captureId: 'cap_c',
    batchId: 'batch_c',
    captureDetail: { review_revision: 4 },
    reviewFails: {
      status: 409,
      body: {
        error: {
          code: 'review_conflict',
          message: 'This review was edited elsewhere (revision 4, you sent 0).',
          details: { current_revision: 4 },
        },
      },
    },
  });
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });

  act(() => result.current.startRecording());
  await waitFor(() => expect(result.current.phase).toBe('recording'));
  act(() => result.current.stopRecording());
  await waitFor(() => expect(result.current.phase).toBe('result'), { timeout: 4000 });
  act(() => result.current.confirmEpisode());

  await waitFor(() => expect(result.current.saveError).not.toBeNull());
  // The take stays on the result panel with the operator's values intact; the
  // count and the strip claim nothing (§12).
  expect(result.current.phase).toBe('result');
  expect(result.current.stats.nRecorded).toBe(0);
  expect(result.current.episodes).toHaveLength(0);
  expect(result.current.pendingTask).toBe('ok');

  // The refetched capture's revision becomes the new compare-and-swap token, so
  // a deliberate re-apply is checked against what is actually stored — the two
  // edits are never merged.
  await waitFor(() => expect(result.current.saveError).not.toBeNull());
  act(() => result.current.dismissSaveError());
  expect(result.current.saveError).toBeNull();
});

test('a 500 review_sidecar_write_failed leaves nothing saved and nothing claimed', async () => {
  phase2Fetch({
    captureId: 'cap_w',
    batchId: 'batch_w',
    reviewFails: {
      status: 500,
      body: {
        error: {
          code: 'review_sidecar_write_failed',
          message: 'Could not write record.json: No space left on device.',
          details: {},
        },
      },
    },
  });
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });

  act(() => result.current.startRecording());
  await waitFor(() => expect(result.current.phase).toBe('recording'));
  act(() => result.current.stopRecording());
  await waitFor(() => expect(result.current.phase).toBe('result'), { timeout: 4000 });
  act(() => result.current.confirmEpisode());

  await waitFor(() => expect(result.current.saveError).not.toBeNull());
  expect(isDestructiveFailure(result.current.saveError)).toBe(true);
  expect(result.current.stats.nRecorded).toBe(0);
  expect(result.current.episodes).toHaveLength(0);
  expect(result.current.phase).toBe('result');
});

// F1: the QUICK auto quality prefers the run's SETTLED quick_check verdict over
// the recorder integrity — a clean-integrity run whose verdict is needs_review
// (e.g. an Hz shortfall the recorder can't see) reads NEEDS REVIEW.
test('auto quality prefers the settled quick_check verdict over integrity', async () => {
  phase2Fetch({
    captureId: 'cap_v',
    batchId: 'batch_v',
    captureDetail: {
      quick_check: {
        verdict: {
          quality: 'needs_review',
          reasons: ['/hsrb/hand_camera/image_raw/compressed avg 9.982Hz < expected 30Hz'],
        },
      },
    },
  });
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });

  act(() => result.current.startRecording());
  await waitFor(() => expect(result.current.phase).toBe('recording'));
  act(() => result.current.stopRecording());
  await waitFor(() => expect(result.current.phase).toBe('result'), { timeout: 4000 });

  // Integrity is 'ok' (status mock) but the settled verdict is needs_review —
  // the verdict wins, and the settled reasons are surfaced to the panel.
  await waitFor(() =>
    expect(result.current.quickCheck.verdict?.quality).toBe('needs_review'),
  );
  expect(result.current.autoQuality).toBe('review');
  expect(result.current.quickCheck.verdict?.reasons[0]).toContain('9.982Hz');
  expect(result.current.quickCheck.pending).toBe(false);
});

// D-2: an operator override changes the quality AND records the honest
// 'operator' provenance; 'Not usable' maps to the server 'not_usable'.
test('an operator quality override sets quality + quality_source=operator', async () => {
  const { calls } = phase2Fetch({ captureId: 'cap_ov', batchId: 'batch_ov' });
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });

  act(() => result.current.startRecording());
  await waitFor(() => expect(result.current.phase).toBe('recording'));
  act(() => result.current.stopRecording());
  await waitFor(() => expect(result.current.phase).toBe('result'), { timeout: 4000 });
  // Auto is 'good' (integrity ok); the operator overrides to Not usable.
  expect(result.current.autoQuality).toBe('good');
  act(() => result.current.setQuality('notusable'));
  act(() => result.current.confirmEpisode());
  await waitFor(() => expect(result.current.stats.nRecorded).toBe(1));

  const patch = calls.find((c) => c.url.includes('/review') && c.method === 'PATCH')!;
  expect(patch.body).toMatchObject({
    task_result: 'success',
    quality: 'not_usable',
    quality_source: 'operator',
    // "Not usable" is the same statement Review's own exclude makes, so the
    // take is not left sitting in the queue it was just taken out of.
    review_status: 'excluded',
  });
  // 'not usable' has no local axis, so the strip/tallies record it as 'review'.
  expect(result.current.stats.nReview).toBe(1);
});

test('ending a batch early PATCHes the server batch to ended_early', async () => {
  const { calls } = phase2Fetch({ captureId: 'cap_e', batchId: 'batch_e' });
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });

  act(() => result.current.startRecording());
  await waitFor(() => expect(result.current.phase).toBe('recording'));
  act(() => result.current.pickEndReason('Safety'));
  act(() => result.current.confirmEndBatch());
  await waitFor(() => expect(result.current.phase).toBe('ended'));

  await waitFor(() =>
    expect(
      calls.some((c) => c.url.includes('/batches/batch_e') && c.method === 'PATCH'),
    ).toBe(true),
  );
  const patch = calls.find(
    (c) => c.url.includes('/batches/batch_e') && c.method === 'PATCH',
  )!;
  expect(patch.body).toMatchObject({ status: 'ended_early', ended_reason: 'Safety' });
});

test('completing the 30th episode PATCHes the batch to completed', async () => {
  const seed = Array.from({ length: EPISODES_PER_BATCH - 1 }, (_, i) => ({
    index: i + 1,
    quality: 'good' as const,
    taskResult: 'ok' as const,
    captureId: `cap_${i + 1}`,
  }));
  window.localStorage.setItem(
    BATCH_STORAGE_KEY,
    JSON.stringify({
      batchNum: 1,
      batchId: 'batch_full',
      episodes: seed,
      project: 'P',
      task: 'T',
      condition: 'C',
    }),
  );
  __rehydrateBatchStore();
  // The seeded batch's captures still exist server-side, so the phantom
  // reconcile leaves it intact (a real in-progress batch, not a stale ghost).
  const { calls } = phase2Fetch({
    captureId: 'cap_30',
    batchId: 'batch_full',
    captures: seed.map((e) => e.captureId),
  });
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  expect(result.current.stats.nRecorded).toBe(EPISODES_PER_BATCH - 1);

  act(() => result.current.startRecording());
  await waitFor(() => expect(result.current.phase).toBe('recording'));
  act(() => result.current.stopRecording());
  await waitFor(() => expect(result.current.phase).toBe('result'), { timeout: 4000 });
  act(() => result.current.pickSuccess());
  act(() => result.current.confirmEpisode());
  await waitFor(() => expect(result.current.phase).toBe('completed'));

  await waitFor(() =>
    expect(
      calls.some(
        (c) =>
          c.url.includes('/batches/batch_full') &&
          c.method === 'PATCH' &&
          c.body?.status === 'completed',
      ),
    ).toBe(true),
  );
});

test('reload restores the active batch from the server (GET /batches?status=active)', async () => {
  phase2Fetch({
    activeBatches: [
      {
        batch_id: 'batch_active',
        project: 'Bin Picking',
        task: 'Bin to Tray',
        condition: 'Bin: full',
        operator: 'yuki',
        target_episodes: 30,
        status: 'active',
        episode_count: 2,
        captures: [
          {
            index_in_batch: 1,
            capture_id: 'cap_r1',
            run_id: 'run_r1',
            task_result: 'success',
            quality: 'good',
            review_status: 'pending',
          },
          {
            index_in_batch: 2,
            capture_id: 'cap_r2',
            run_id: 'run_r2',
            task_result: 'failure',
            quality: 'needs_review',
            review_status: 'pending',
          },
        ],
      },
    ],
  });
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });

  await waitFor(() => expect(result.current.stats.nRecorded).toBe(2));
  expect(result.current.project).toBe('Bin Picking');
  expect(result.current.task).toBe('Bin to Tray');
  expect(result.current.condition).toBe('Bin: full');
  // Second episode's needs_review maps to the local 'review' quality axis.
  expect(result.current.stats.nReview).toBe(1);
  expect(result.current.stats.epNext).toBe(3);
});

// The batch list is a count per batch, not a row per capture (E-27), so the
// episodes of the restored batch can only come from its detail. Reading them
// off the list item instead is not a smaller restore — it is no restore at
// all, and the failure is silent: the hydrate chain's trailing catch (there
// for an unreachable API) swallows the TypeError and Collect comes back empty
// after a reload, mid-batch.
test('the active-batch restore reads the batch detail for its episodes', async () => {
  const { calls } = phase2Fetch({
    activeBatches: [
      // A finished batch, listed first. It exists so "one detail request" means
      // "the active one" and not "one per batch": with a single batch in the
      // list those two are the same number, and a restore that walked every
      // batch's detail — the N+1 the server just removed, rebuilt on the
      // client — would count as one request and pass. Its captures are
      // deliberately real, so a restore that took the FIRST batch's detail
      // instead of the active one is caught by the strip below, not only by
      // the request count.
      {
        batch_id: 'batch_done',
        batch_seq: 2,
        project: 'Bin Picking',
        task: 'Bin to Tray',
        condition: 'Bin: empty',
        target_episodes: 30,
        status: 'completed',
        episode_count: 3,
        episodes_recorded: 3,
        captures: [
          {
            index_in_batch: 1,
            capture_id: 'cap_old1',
            run_id: 'run_old1',
            task_result: 'success',
            quality: 'good',
            review_status: 'adopted',
          },
          {
            index_in_batch: 2,
            capture_id: 'cap_old2',
            run_id: 'run_old2',
            task_result: 'success',
            quality: 'good',
            review_status: 'adopted',
          },
          {
            index_in_batch: 3,
            capture_id: 'cap_old3',
            run_id: 'run_old3',
            task_result: 'success',
            quality: 'good',
            review_status: 'adopted',
          },
        ],
      },
      {
        batch_id: 'batch_detail',
        batch_seq: 3,
        project: 'Bin Picking',
        task: 'Bin to Tray',
        condition: 'Bin: full',
        target_episodes: 30,
        status: 'active',
        // The list carries these two numbers about its captures and nothing else.
        episode_count: 2,
        episodes_recorded: 2,
        captures: [
          {
            index_in_batch: 1,
            capture_id: 'cap_d1',
            run_id: 'run_d1',
            task_result: 'success',
            quality: 'good',
            review_status: 'adopted',
          },
          {
            index_in_batch: 2,
            capture_id: 'cap_d2',
            run_id: 'run_d2',
            task_result: 'failure',
            quality: 'needs_review',
            review_status: 'pending',
          },
        ],
      },
    ],
  });
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });

  // The strip is populated from the detail's captures, keyed by capture_id and
  // placed by index_in_batch (§1) — not merely counted.
  await waitFor(() => expect(result.current.episodes).toHaveLength(2));
  expect(result.current.episodes.map((e) => e.captureId)).toEqual([
    'cap_d1',
    'cap_d2',
  ]);
  expect(result.current.episodes.map((e) => e.index)).toEqual([1, 2]);
  expect(result.current.stats.nReview).toBe(1);
  expect(result.current.batchSeq).toBe(3);
  expect(
    calls.some((c) => c.method === 'GET' && c.url.includes('/batches/batch_detail')),
  ).toBe(true);
  // And the detail was asked for the ACTIVE batch only — one extra request, not
  // one per batch (the N+1 the server-side change just removed). The finished
  // batch in the list is never opened: nothing on this screen wants it.
  expect(calls.some((c) => c.url.includes('/batches/batch_done'))).toBe(false);
  expect(
    calls.filter((c) => c.method === 'GET' && /\/batches\/[^/?]+$/.test(c.url)),
  ).toHaveLength(1);
  // No capture is a suspect (all of them are the server's), so the restore does
  // not go on to interrogate /captures/{id} about any of them.
  expect(calls.some((c) => c.url.includes('/captures/cap_d1'))).toBe(false);
});

// A detail that cannot be read is the case the localStorage fallback exists
// for. Adopting the list item alone would replace a strip of real episodes
// with an empty one beside a non-zero count — a worse answer than the
// fallback, and one the operator cannot tell from "nothing was recorded".
test('a batch detail that fails leaves the localStorage restore standing', async () => {
  window.localStorage.setItem(
    BATCH_STORAGE_KEY,
    JSON.stringify({
      batchSeq: 9,
      recordedCount: 2,
      batchId: 'batch_offline',
      episodes: [
        { index: 1, quality: 'good', taskResult: 'ok', captureId: 'cap_l1' },
        { index: 2, quality: 'good', taskResult: 'ok', captureId: 'cap_l2' },
      ],
      project: 'Local project',
      task: 'Local task',
      condition: 'Local condition',
    }),
  );
  __rehydrateBatchStore();
  const { calls } = phase2Fetch({
    batchDetailStatus: 503,
    activeBatches: [
      {
        batch_id: 'batch_offline',
        batch_seq: 9,
        project: 'Server project',
        task: 'Server task',
        target_episodes: 30,
        status: 'active',
        episode_count: 2,
        episodes_recorded: 2,
        captures: [
          {
            index_in_batch: 1,
            capture_id: 'cap_l1',
            run_id: 'run_l1',
            task_result: 'success',
            quality: 'good',
            review_status: 'pending',
          },
        ],
      },
    ],
  });
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });

  await waitFor(() =>
    expect(
      calls.some((c) => c.method === 'GET' && c.url.includes('/batches/batch_offline')),
    ).toBe(true),
  );
  // The local context survives whole: episodes, count and labels.
  expect(result.current.episodes).toHaveLength(2);
  expect(result.current.stats.nRecorded).toBe(2);
  expect(result.current.project).toBe('Local project');
  expect(result.current.task).toBe('Local task');
});

// ---------------------------------------------------------------------------
// Phantom batch (Apple P0): a local batch context whose runs were deleted
// server-side must not survive as fabricated counters on the hero screen.
// ---------------------------------------------------------------------------

// A stale batch persisted locally (batch 6, 3 recorded) whose runs no longer
// exist, and a server that reports no active batch and no runs, is discarded —
// the counters reset to the honest empty state.
test('a stale local batch is discarded when the server has no active batch and its captures are gone', async () => {
  window.localStorage.setItem(
    BATCH_STORAGE_KEY,
    JSON.stringify({
      batchSeq: 6,
      recordedCount: 3,
      batchId: 'batch_ghost',
      episodes: [
        { index: 1, quality: 'good', taskResult: 'ok', captureId: 'ghost_1' },
        { index: 2, quality: 'good', taskResult: 'ok', captureId: 'ghost_2' },
        { index: 3, quality: 'review', taskResult: 'fail', captureId: 'ghost_3' },
      ],
      project: 'Bin Picking',
      task: 'Bin to Tray',
      condition: 'Bin: full',
    }),
  );
  __rehydrateBatchStore();
  // Server: no active batch (default empty activeBatches) and no captures.
  phase2Fetch({ captures: [] });
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });

  // Before reconcile the seeded phantom is visible …
  expect(result.current.stats.nRecorded).toBe(3);
  expect(result.current.batchSeq).toBe(6);
  // … then the reconcile discards it: counts fall back to the honest empty state.
  await waitFor(() => expect(result.current.stats.nRecorded).toBe(0));
  expect(result.current.batchSeq).toBeNull();
  expect(result.current.episodes).toHaveLength(0);
  expect(result.current.stats.epNext).toBe(1);
  // The persisted blob is cleared too, so a later reload doesn't resurrect it.
  expect(window.localStorage.getItem(BATCH_STORAGE_KEY)).toBeNull();
});

// Offline resilience: if the /captures check itself fails, the local batch is
// kept (we never discard a batch we couldn't prove is stale).
test('a local batch is kept when the captures check fails (API error → keep)', async () => {
  window.localStorage.setItem(
    BATCH_STORAGE_KEY,
    JSON.stringify({
      batchSeq: 6,
      recordedCount: 3,
      batchId: 'batch_maybe',
      episodes: [
        { index: 1, quality: 'good', taskResult: 'ok', captureId: 'x1' },
        { index: 2, quality: 'good', taskResult: 'ok', captureId: 'x2' },
        { index: 3, quality: 'good', taskResult: 'ok', captureId: 'x3' },
      ],
      project: 'P',
      task: 'T',
      condition: 'C',
    }),
  );
  __rehydrateBatchStore();
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push(`${method} ${url}`);
    if (url.includes('/batches') && method === 'GET') {
      return Promise.resolve(jsonResponse({ items: [] }));
    }
    if (method === 'GET' && /\/captures(\?|$)/.test(url)) {
      // The captures check errors — we must NOT clear the local batch.
      return Promise.resolve(
        jsonResponse({ error: { code: 'io', message: 'down' } }, 500),
      );
    }
    return Promise.resolve(jsonResponse({}));
  });
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });

  // Wait until the reconcile has attempted (and failed) the captures check …
  await waitFor(() =>
    expect(calls.some((c) => /GET .*\/captures(\?|$)/.test(c))).toBe(true),
  );
  // … and confirm the local batch survived (offline resilience preserved).
  expect(result.current.stats.nRecorded).toBe(3);
  expect(result.current.batchSeq).toBe(6);
  expect(window.localStorage.getItem(BATCH_STORAGE_KEY)).not.toBeNull();
});

// An active batch on the server always wins over a stale local one (server
// truth), rather than being treated as a phantom (see also the restore test).
test('an active server batch overrides a stale local batch (server wins, not discarded)', async () => {
  window.localStorage.setItem(
    BATCH_STORAGE_KEY,
    JSON.stringify({
      batchSeq: 6,
      recordedCount: 3,
      batchId: 'batch_old',
      episodes: [{ index: 1, quality: 'good', taskResult: 'ok', captureId: 'old_1' }],
      project: 'Old',
      task: 'Old task',
      condition: 'Old',
    }),
  );
  __rehydrateBatchStore();
  phase2Fetch({
    activeBatches: [
      {
        batch_id: 'batch_new',
        batch_seq: 7,
        project: 'Bin Picking',
        task: 'Bin to Tray',
        condition: 'Bin: full',
        target_episodes: 30,
        status: 'active',
        episodes_recorded: 5,
        episode_count: 1,
        captures: [
          {
            index_in_batch: 5,
            capture_id: 'cap_r5',
            run_id: 'run_r5',
            task_result: 'success',
            quality: 'good',
            review_status: 'pending',
          },
        ],
      },
    ],
  });
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });

  await waitFor(() => expect(result.current.batchSeq).toBe(7));
  expect(result.current.stats.nRecorded).toBe(5);
  expect(result.current.project).toBe('Bin Picking');
});

// ---------------------------------------------------------------------------
// Monotone recorded count: a Review exclude/delete must never lower Collect's
// counts (the user-reported inconsistency).
// ---------------------------------------------------------------------------

test('restore keeps the recorded count monotone after a Review delete (episodes_recorded)', async () => {
  phase2Fetch({
    activeBatches: [
      {
        batch_id: 'batch_del',
        project: 'P',
        task: 'T',
        condition: 'C',
        target_episodes: 30,
        status: 'active',
        episodes_recorded: 3, // 3 episodes were recorded …
        episode_count: 2,
        captures: [
          // … but one was deleted in Review, so only 2 survive (index 2 gone).
          {
            index_in_batch: 1,
            capture_id: 'cap_r1',
            run_id: 'run_r1',
            task_result: 'success',
            quality: 'good',
            review_status: 'adopted',
          },
          {
            index_in_batch: 3,
            capture_id: 'cap_r3',
            run_id: 'run_r3',
            task_result: 'success',
            quality: 'good',
            review_status: 'pending',
          },
        ],
      },
    ],
  });
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });

  await waitFor(() => expect(result.current.stats.nRecorded).toBe(3));
  // Count is monotone (3) and next follows it (#4); tallies use the 2 survivors.
  expect(result.current.stats.epNext).toBe(4);
  expect(result.current.episodes).toHaveLength(2);
  expect(result.current.stats.nRemaining).toBe(27);
});

test('an excluded episode still counts toward the recorded total', async () => {
  phase2Fetch({
    activeBatches: [
      {
        batch_id: 'batch_x',
        project: 'P',
        task: 'T',
        target_episodes: 30,
        status: 'active',
        episodes_recorded: 2,
        episode_count: 2,
        captures: [
          {
            index_in_batch: 1,
            capture_id: 'cap_r1',
            run_id: 'run_r1',
            task_result: 'success',
            quality: 'good',
            review_status: 'pending',
          },
          {
            index_in_batch: 2,
            capture_id: 'cap_r2',
            run_id: 'run_r2',
            task_result: 'success',
            quality: 'not_usable',
            review_status: 'excluded',
          },
        ],
      },
    ],
  });
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });

  await waitFor(() => expect(result.current.stats.nRecorded).toBe(2));
  // The excluded episode is NOT filtered out of the count or the strip.
  expect(result.current.episodes).toHaveLength(2);
  expect(result.current.stats.epNext).toBe(3);
});

test('a server restore never LOWERS a higher local recorded count', async () => {
  const episodes = Array.from({ length: 5 }, (_, i) => ({
    index: i + 1,
    quality: 'good' as const,
    taskResult: 'ok' as const,
    captureId: `cap_r${i + 1}`,
  }));
  window.localStorage.setItem(
    BATCH_STORAGE_KEY,
    JSON.stringify({
      batchSeq: null,
      recordedCount: 5,
      batchId: 'batch_hi',
      episodes,
      project: 'P',
      task: 'T',
      condition: 'C',
    }),
  );
  __rehydrateBatchStore();
  // Server reports the SAME batch (batch_seq 7) but a stale lower count (2).
  phase2Fetch({
    activeBatches: [
      {
        batch_id: 'batch_hi',
        batch_seq: 7,
        project: 'P',
        task: 'T',
        target_episodes: 30,
        status: 'active',
        episodes_recorded: 2,
        episode_count: 2,
        captures: [
          {
            index_in_batch: 1,
            capture_id: 'cap_r1',
            run_id: 'run_r1',
            task_result: 'success',
            quality: 'good',
            review_status: 'pending',
          },
          {
            index_in_batch: 2,
            capture_id: 'cap_r2',
            run_id: 'run_r2',
            task_result: 'success',
            quality: 'good',
            review_status: 'pending',
          },
        ],
      },
    ],
  });
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });

  // The restore adopts the server batch (its batch_seq) but keeps the higher
  // local count (5), never lowering it to the server's stale 2.
  await waitFor(() => expect(result.current.batchSeq).toBe(7));
  expect(result.current.stats.nRecorded).toBe(5);
  expect(result.current.stats.epNext).toBe(6);
});

// The reported "just-saved chip flips back to not-recorded" bug: an episode
// that only reached the browser bridge (its POST failed / hadn't landed) must
// SURVIVE a same-batch server restore instead of being dropped from the strip.
test('a same-batch server restore keeps an episode the server does not know about', async () => {
  const episodes = Array.from({ length: 3 }, (_, i) => ({
    index: i + 1,
    quality: 'good' as const,
    taskResult: 'ok' as const,
    captureId: `cap_r${i + 1}`,
  }));
  window.localStorage.setItem(
    BATCH_STORAGE_KEY,
    JSON.stringify({
      batchSeq: 7,
      recordedCount: 3,
      batchId: 'batch_active',
      episodes,
      project: 'P',
      task: 'T',
      condition: 'C',
    }),
  );
  __rehydrateBatchStore();
  // The server knows the same batch but only episodes 1-2 (r3's POST never
  // landed) — its stale list must not erase the locally-saved episode 3.
  phase2Fetch({
    activeBatches: [
      {
        batch_id: 'batch_active',
        batch_seq: 7,
        project: 'P',
        task: 'T',
        target_episodes: 30,
        status: 'active',
        episodes_recorded: 2,
        episode_count: 2,
        captures: [
          {
            index_in_batch: 1,
            capture_id: 'cap_r1',
            run_id: 'run_r1',
            task_result: 'success',
            quality: 'good',
            review_status: 'pending',
          },
          {
            index_in_batch: 2,
            capture_id: 'cap_r2',
            run_id: 'run_r2',
            task_result: 'success',
            quality: 'good',
            review_status: 'pending',
          },
        ],
      },
    ],
  });
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });

  await waitFor(() => expect(result.current.batchSeq).toBe(7));
  expect(result.current.episodes).toHaveLength(3);
  expect(result.current.episodes.map((e) => e.index)).toEqual([1, 2, 3]);
  expect(result.current.stats.nRecorded).toBe(3);
  expect(result.current.stats.epNext).toBe(4);
});

// A discard invalidates the capture cache, so the take stops being offered as
// an unsaved one — the review it never got is not something a browser-local
// mirror has to be told about any more; the capture itself is gone.
test('discarding the take refreshes the capture cache and re-arms for a retake', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.includes('/record/status')) {
      return Promise.resolve(
        jsonResponse({
          capture_id: 'cap_disc',
          run_id: 'run_cap_disc',
          state: 'completed',
          live_capture_ids: [],
          integrity: 'ok',
        }),
      );
    }
    if (url.includes('/record/start'))
      return Promise.resolve(jsonResponse(captureBody('cap_disc')));
    if (url.includes('/record/stop'))
      return Promise.resolve(
        jsonResponse(captureBody('cap_disc', { state: 'completed' })),
      );
    if (url.includes('/captures/cap_disc/delete') && method === 'POST')
      return Promise.resolve(
        jsonResponse(captureBody('cap_disc', { state: 'discarded' })),
      );
    if (url.includes('/captures/cap_disc'))
      return Promise.resolve(
        jsonResponse(captureBody('cap_disc', { state: 'completed', bytes: 4096 })),
      );
    if (url.includes('/captures'))
      return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
    return Promise.resolve(jsonResponse({}));
  });

  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  act(() => result.current.startRecording());
  await waitFor(() => expect(result.current.phase).toBe('recording'));
  act(() => result.current.stopRecording());
  await waitFor(() => expect(result.current.phase).toBe('result'), { timeout: 4000 });

  // One press does it all — no dialog opens, the ledger reason is automatic.
  await act(async () => {
    result.current.discardEpisode();
  });
  await waitFor(() => expect(result.current.phase).toBe('ready'));
  expect(result.current.episodeDiscard.kind).toBeNull();
  const del = fetchMock.mock.calls.find(
    ([u, i]) =>
      String(u).includes('/captures/cap_disc/delete') && i?.method === 'POST',
  );
  expect(JSON.parse(String((del![1] as RequestInit).body))).toEqual({
    kind: 'discard',
    reason: 'Collect one-click discard (no reason asked)',
  });
});

// ---------------------------------------------------------------------------
// Batch reset: close the current batch, counts → 0/30, recordings kept.
// ---------------------------------------------------------------------------

test('resetBatch clears the counts, PATCHes the batch ended_early=reset, and deletes nothing', async () => {
  const { calls } = phase2Fetch({ captureId: 'cap_r', batchId: 'batch_r' });
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });

  act(() => result.current.startRecording());
  await waitFor(() => expect(result.current.phase).toBe('recording'));
  act(() => result.current.stopRecording());
  await waitFor(() => expect(result.current.phase).toBe('result'), { timeout: 4000 });
  act(() => result.current.pickSuccess());
  act(() => result.current.confirmEpisode());
  await waitFor(() => expect(result.current.stats.nRecorded).toBe(1));

  act(() => result.current.resetBatch());

  // Counts back to 0/30, batch number cleared (server re-assigns on next record),
  // back to a ready fresh batch.
  expect(result.current.stats.nRecorded).toBe(0);
  expect(result.current.stats.epNext).toBe(1);
  expect(result.current.batchSeq).toBeNull();
  expect(result.current.phase).toBe('ready');
  expect(result.current.episodes).toHaveLength(0);

  // The old server batch is closed as ended_early='reset' (best-effort) …
  await waitFor(() =>
    expect(
      calls.some(
        (c) =>
          c.url.includes('/batches/batch_r') &&
          c.method === 'PATCH' &&
          c.body?.status === 'ended_early' &&
          c.body?.ended_reason === 'reset',
      ),
    ).toBe(true),
  );
  // … and NO recording was deleted (they stay in Review).
  expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
});

test('after a reset, the next recording start lazily creates a fresh server batch', async () => {
  const { calls } = phase2Fetch({ captureId: 'cap_r', batchId: 'batch_r' });
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });

  act(() => result.current.startRecording()); // creates batch #1
  await waitFor(() => expect(result.current.phase).toBe('recording'));
  act(() => result.current.stopRecording());
  await waitFor(() => expect(result.current.phase).toBe('result'), { timeout: 4000 });
  act(() => result.current.pickSuccess());
  act(() => result.current.confirmEpisode());
  await waitFor(() => expect(result.current.stats.nRecorded).toBe(1));

  act(() => result.current.resetBatch());
  expect(result.current.stats.nRecorded).toBe(0);

  const postsBefore = calls.filter(
    (c) => c.url.includes('/batches') && c.method === 'POST',
  ).length;
  act(() => result.current.startRecording()); // must lazily create batch #2
  await waitFor(() => expect(result.current.phase).toBe('recording'));
  await waitFor(() =>
    expect(
      calls.filter((c) => c.url.includes('/batches') && c.method === 'POST').length,
    ).toBe(postsBefore + 1),
  );
});

// ---------------------------------------------------------------------------
// Auto-rollover: a context change (project/task/condition) once the current set
// already holds a recording closes it and opens a fresh set, so earlier episodes
// keep their original context. A set with nothing recorded yet is updated in
// place (no empty set minted).
// ---------------------------------------------------------------------------

test('ROLLOVER_SET resets counts/handles, keeps the target, applies the new context, and predicts the next set number from a known seq', () => {
  const s0 = {
    ...createState(),
    batchSeq: 5,
    batchId: 'batch_5',
    recordedCount: 3,
    targetEpisodes: 20,
    episodes: [
      {
        index: 1,
        quality: 'good' as const,
        taskResult: 'ok' as const,
        captureId: 'cap_1',
      },
    ],
    phase: 'ready' as const,
    pendingTask: 'ok' as const,
    failReason: 'x',
    currentCaptureId: 'cap_live',
    predictedSeq: 1,
  };
  const s = reducer(s0, {
    type: 'ROLLOVER_SET',
    project: 'Bin Picking',
    task: 'Bin to Tray',
    condition: 'Bin: full',
  });
  expect(s.episodes).toHaveLength(0);
  expect(s.recordedCount).toBe(0);
  expect(s.batchId).toBeNull();
  expect(s.batchSeq).toBeNull();
  expect(s.targetEpisodes).toBe(20); // inherited, not reset to 30
  expect(s.project).toBe('Bin Picking');
  expect(s.task).toBe('Bin to Tray');
  expect(s.condition).toBe('Bin: full');
  expect(s.phase).toBe('ready');
  // In-flight / result fields are cleared like a fresh set.
  expect(s.pendingTask).toBeNull();
  expect(s.failReason).toBe('');
  expect(s.currentCaptureId).toBeNull();
  // The next set most likely gets old seq + 1.
  expect(s.predictedSeq).toBe(6);
});

test('ROLLOVER_SET leaves predictedSeq unchanged when the closing set had no known seq', () => {
  const s0 = {
    ...createState(),
    batchSeq: null,
    recordedCount: 1,
    predictedSeq: 3,
  };
  const s = reducer(s0, {
    type: 'ROLLOVER_SET',
    project: 'Kitchen Mobile',
    task: 'Drawer Open',
    condition: 'Drawer: top',
  });
  expect(s.batchSeq).toBeNull();
  expect(s.recordedCount).toBe(0);
  expect(s.predictedSeq).toBe(3); // unknown old seq → left as-is
});

test('changing the condition once the set has a recording rolls the set over (old set PATCHed ended_early + Condition change, counts reset, target kept, next number predicted)', async () => {
  const { calls } = phase2Fetch({
    activeBatches: [
      {
        batch_id: 'batch_seed',
        batch_seq: 5,
        project: 'Tabletop Manipulation',
        task: 'Pick and Place',
        condition: 'Object: Left → Tray: Center',
        target_episodes: 20,
        status: 'active',
        episode_count: 1,
        captures: [
          {
            index_in_batch: 1,
            capture_id: 'cap_r1',
            run_id: 'run_r1',
            task_result: 'success',
            quality: 'good',
            review_status: 'pending',
          },
        ],
      },
    ],
  });
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  // Server restore adopts the active set (1 recorded, seq 5, target 20).
  await waitFor(() => expect(result.current.stats.nRecorded).toBe(1));
  expect(result.current.batchSeq).toBe(5);

  act(() => result.current.pickCondition('Object: Center → Tray: Center'));

  // Rolled over: a fresh empty set, target inherited, next number predicted.
  expect(result.current.stats.nRecorded).toBe(0);
  expect(result.current.batchSeq).toBeNull();
  expect(result.current.targetEpisodes).toBe(20);
  expect(result.current.condition).toBe('Object: Center → Tray: Center');
  expect(result.current.predictedSeq).toBe(6);
  expect(result.current.phase).toBe('ready');

  // The old set is closed server-side as ended_early / Condition change.
  await waitFor(() =>
    expect(
      calls.some(
        (c) =>
          c.url.includes('/batches/batch_seed') &&
          c.method === 'PATCH' &&
          c.body?.status === 'ended_early' &&
          c.body?.ended_reason === 'Condition change',
      ),
    ).toBe(true),
  );
});

test('changing the condition before any recording updates in place (PATCH {condition}, no rollover, no new set minted)', async () => {
  const { calls } = phase2Fetch({
    activeBatches: [
      {
        batch_id: 'batch0',
        batch_seq: 4,
        project: 'Tabletop Manipulation',
        task: 'Pick and Place',
        condition: 'Object: Left → Tray: Center',
        target_episodes: 20,
        status: 'active',
        episode_count: 0,
        captures: [],
      },
    ],
  });
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  await waitFor(() => expect(result.current.batchSeq).toBe(4));
  expect(result.current.stats.nRecorded).toBe(0);

  act(() => result.current.pickCondition('Object: Right → Tray: Center'));

  // In place: same set (id + number), condition updated, nothing rolled over.
  expect(result.current.batchSeq).toBe(4);
  expect(result.current.stats.nRecorded).toBe(0);
  expect(result.current.condition).toBe('Object: Right → Tray: Center');

  await waitFor(() =>
    expect(
      calls.some(
        (c) =>
          c.url.includes('/batches/batch0') &&
          c.method === 'PATCH' &&
          c.body?.condition === 'Object: Right → Tray: Center',
      ),
    ).toBe(true),
  );
  // No terminal PATCH — the set was not ended.
  expect(
    calls.some((c) => c.method === 'PATCH' && c.body?.status === 'ended_early'),
  ).toBe(false);
});

test('pickCustomCondition trims whitespace and ignores an empty value', async () => {
  const { calls } = phase2Fetch({
    activeBatches: [
      {
        batch_id: 'batch0',
        batch_seq: 4,
        project: 'Tabletop Manipulation',
        task: 'Pick and Place',
        condition: 'Object: Left → Tray: Center',
        target_episodes: 20,
        status: 'active',
        episode_count: 0,
        captures: [],
      },
    ],
  });
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  await waitFor(() => expect(result.current.batchSeq).toBe(4));

  // Empty / whitespace-only is a no-op (no condition change, no PATCH).
  act(() => result.current.pickCustomCondition('   '));
  expect(result.current.condition).toBe('Object: Left → Tray: Center');
  expect(calls.some((c) => c.method === 'PATCH')).toBe(false);

  // A trimmed custom string applies just like a catalog condition (in place at 0).
  act(() => result.current.pickCustomCondition('  Wet floor  '));
  expect(result.current.condition).toBe('Wet floor');
  await waitFor(() =>
    expect(
      calls.some(
        (c) =>
          c.url.includes('/batches/batch0') &&
          c.method === 'PATCH' &&
          c.body?.condition === 'Wet floor',
      ),
    ).toBe(true),
  );
});

test('changing the task before any recording PATCHes {task, condition} onto the empty batch in place', async () => {
  const { calls } = phase2Fetch({
    activeBatches: [
      {
        batch_id: 'batch0',
        batch_seq: 4,
        project: 'Tabletop Manipulation',
        task: 'Pick and Place',
        condition: 'Object: Left → Tray: Center',
        target_episodes: 20,
        status: 'active',
        episode_count: 0,
        captures: [],
      },
    ],
  });
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  await waitFor(() => expect(result.current.batchSeq).toBe(4));

  act(() => result.current.pickTask('Stacking'));

  // In place: same set, task + its first condition synced to the server.
  expect(result.current.batchSeq).toBe(4);
  expect(result.current.task).toBe('Stacking');
  expect(result.current.condition).toBe('Blocks: 3');
  await waitFor(() =>
    expect(
      calls.some(
        (c) =>
          c.url.includes('/batches/batch0') &&
          c.method === 'PATCH' &&
          c.body?.task === 'Stacking' &&
          c.body?.condition === 'Blocks: 3',
      ),
    ).toBe(true),
  );
  // Not a rollover — no terminal PATCH.
  expect(
    calls.some((c) => c.method === 'PATCH' && c.body?.status === 'ended_early'),
  ).toBe(false);
});

test('changing the project before any recording PATCHes {project, task, condition} in place', async () => {
  const { calls } = phase2Fetch({
    activeBatches: [
      {
        batch_id: 'batch0',
        batch_seq: 4,
        project: 'Tabletop Manipulation',
        task: 'Pick and Place',
        condition: 'Object: Left → Tray: Center',
        target_episodes: 20,
        status: 'active',
        episode_count: 0,
        captures: [],
      },
    ],
  });
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  await waitFor(() => expect(result.current.batchSeq).toBe(4));

  act(() => result.current.pickProject('Bin Picking'));

  expect(result.current.batchSeq).toBe(4);
  expect(result.current.project).toBe('Bin Picking');
  expect(result.current.task).toBe('Bin to Tray');
  expect(result.current.condition).toBe('Bin: full');
  await waitFor(() =>
    expect(
      calls.some(
        (c) =>
          c.url.includes('/batches/batch0') &&
          c.method === 'PATCH' &&
          c.body?.project === 'Bin Picking' &&
          c.body?.task === 'Bin to Tray' &&
          c.body?.condition === 'Bin: full',
      ),
    ).toBe(true),
  );
});

test('a custom task before any recording PATCHes only {task} (no condition sent — batch keeps its prior one)', async () => {
  const { calls } = phase2Fetch({
    activeBatches: [
      {
        batch_id: 'batch0',
        batch_seq: 4,
        project: 'Tabletop Manipulation',
        task: 'Pick and Place',
        condition: 'Object: Left → Tray: Center',
        target_episodes: 20,
        status: 'active',
        episode_count: 0,
        captures: [],
      },
    ],
  });
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  await waitFor(() => expect(result.current.batchSeq).toBe(4));

  act(() => result.current.pickCustomTask('  Handover  '));

  // In place, trimmed; the machine clears the condition to '—' locally.
  expect(result.current.batchSeq).toBe(4);
  expect(result.current.task).toBe('Handover');
  expect(result.current.condition).toBe('—');
  await waitFor(() =>
    expect(
      calls.some((c) => c.url.includes('/batches/batch0') && c.method === 'PATCH'),
    ).toBe(true),
  );
  const patch = calls.find(
    (c) => c.url.includes('/batches/batch0') && c.method === 'PATCH',
  )!;
  expect(patch.body).toEqual({ task: 'Handover' });
  // A '—' condition is never sent (matches the create path's omit).
  expect('condition' in (patch.body ?? {})).toBe(false);
});

test('changing the task once the set has a recording rolls over with a Task change reason', async () => {
  const { calls } = phase2Fetch({ captureId: 'cap_t', batchId: 'batch_t' });
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });

  // Record + save one episode so the set has content.
  act(() => result.current.startRecording());
  await waitFor(() => expect(result.current.phase).toBe('recording'));
  act(() => result.current.stopRecording());
  await waitFor(() => expect(result.current.phase).toBe('result'), { timeout: 4000 });
  act(() => result.current.pickSuccess());
  act(() => result.current.confirmEpisode());
  await waitFor(() => expect(result.current.stats.nRecorded).toBe(1));
  const predictedBefore = result.current.predictedSeq;

  act(() => result.current.pickCustomTask('Handover'));

  // Rolled over to a fresh set carrying the new (free-text) task.
  expect(result.current.stats.nRecorded).toBe(0);
  expect(result.current.batchSeq).toBeNull();
  expect(result.current.task).toBe('Handover');
  expect(result.current.condition).toBe('—');
  // The closing set's seq was never assigned (test fixture) → prediction untouched.
  expect(result.current.predictedSeq).toBe(predictedBefore);

  await waitFor(() =>
    expect(
      calls.some(
        (c) =>
          c.url.includes('/batches/batch_t') &&
          c.method === 'PATCH' &&
          c.body?.status === 'ended_early' &&
          c.body?.ended_reason === 'Task change',
      ),
    ).toBe(true),
  );
});

test('changing the project once the set has a recording rolls over with a Plan change reason and predicts the next number', async () => {
  const { calls } = phase2Fetch({
    activeBatches: [
      {
        batch_id: 'batch_pj',
        batch_seq: 2,
        project: 'Tabletop Manipulation',
        task: 'Pick and Place',
        condition: 'Object: Left → Tray: Center',
        target_episodes: 30,
        status: 'active',
        episode_count: 1,
        captures: [
          {
            index_in_batch: 1,
            capture_id: 'cap_r1',
            run_id: 'run_r1',
            task_result: 'success',
            quality: 'good',
            review_status: 'pending',
          },
        ],
      },
    ],
  });
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  await waitFor(() => expect(result.current.stats.nRecorded).toBe(1));
  expect(result.current.batchSeq).toBe(2);

  act(() => result.current.pickProject('Bin Picking'));

  // The new project reloads its first task + condition into a fresh set.
  expect(result.current.stats.nRecorded).toBe(0);
  expect(result.current.batchSeq).toBeNull();
  expect(result.current.project).toBe('Bin Picking');
  expect(result.current.task).toBe('Bin to Tray');
  expect(result.current.condition).toBe('Bin: full');
  expect(result.current.predictedSeq).toBe(3);

  await waitFor(() =>
    expect(
      calls.some(
        (c) =>
          c.url.includes('/batches/batch_pj') &&
          c.method === 'PATCH' &&
          c.body?.status === 'ended_early' &&
          c.body?.ended_reason === 'Plan change',
      ),
    ).toBe(true),
  );
});

// With /batches down the capture still carries its own review (§8), so the save
// succeeds and only the grouping is lost. The review is never dropped on the
// floor and never mirrored into the browser — there is nowhere left to mirror it.
test('a batch the API could not create leaves the review saved but ungrouped', async () => {
  const calls: { url: string; method: string; body: unknown }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes('/batches')) return Promise.reject(new Error('api down'));
    if (url.includes('/record/status')) {
      return Promise.resolve(
        jsonResponse({
          capture_id: 'cap_x',
          run_id: 'run_cap_x',
          state: 'completed',
          live_capture_ids: [],
          integrity: 'ok',
        }),
      );
    }
    if (url.includes('/record/start'))
      return Promise.resolve(jsonResponse(captureBody('cap_x')));
    if (url.includes('/record/stop'))
      return Promise.resolve(jsonResponse(captureBody('cap_x', { state: 'completed' })));
    if (url.includes('/review') && method === 'PATCH')
      return Promise.resolve(
        jsonResponse(captureBody('cap_x', { state: 'completed', review_revision: 1 })),
      );
    if (url.includes('/captures'))
      return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
    return Promise.resolve(jsonResponse({}));
  });
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });

  act(() => result.current.startRecording());
  await waitFor(() => expect(result.current.phase).toBe('recording'));
  act(() => result.current.stopRecording());
  await waitFor(() => expect(result.current.phase).toBe('result'), { timeout: 4000 });
  act(() => result.current.pickSuccess());
  act(() => result.current.confirmEpisode());
  await waitFor(() => expect(result.current.stats.nRecorded).toBe(1));

  const patch = calls.find((c) => c.url.includes('/review') && c.method === 'PATCH')!;
  // No batch to belong to, so no batch_id and no index inside one — an index
  // within no batch would mean nothing.
  expect(patch.body).toMatchObject({ batch_id: null, index_in_batch: null });
  expect(result.current.saveError).toBeNull();

  // Reset still works locally even though every batch call failed.
  act(() => result.current.resetBatch());
  expect(result.current.stats.nRecorded).toBe(0);
  expect(result.current.phase).toBe('ready');
});

// ---------------------------------------------------------------------------
// Next-batch prediction: the honest pre-state shown before a batch exists.
// batch_seq resets per (robot, local date) server-side, so the prediction is
// 1 + max(batch_seq) among TODAY's batches (yesterday's numbers don't count),
// falling back to #1 when there are none or the API is unreachable.
// ---------------------------------------------------------------------------

// Pin the clock: NOW_ISO used to be captured at module load while isLocalToday
// reads new Date() at assertion time, so a real clock straddling local midnight
// between the two made "today" mean different days and the prediction fail.
// The three prediction tests below call vi.setSystemTime(PREDICTION_CLOCK) as
// their first act (NOT a file-level hook — that would pin the clock for all 87
// tests in this file); the global afterEach's useRealTimers() unpins it.
const PREDICTION_CLOCK = new Date('2026-08-02T12:00:00Z');
const NOW_ISO = PREDICTION_CLOCK.toISOString();
// ~2 days back — safely a prior LOCAL calendar day regardless of time-of-day.
const OLD_ISO = new Date(PREDICTION_CLOCK.getTime() - 2 * 86_400_000).toISOString();

test("predictedSeq = 1 + max(batch_seq) among today's batches (older days excluded)", async () => {
  vi.setSystemTime(PREDICTION_CLOCK);
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/batches')) {
      return Promise.resolve(
        jsonResponse({
          items: [
            // Yesterday's #9 must NOT leak into today's prediction.
            {
              batch_id: 'b_old',
              status: 'completed',
              batch_seq: 9,
              created_at: OLD_ISO,
              episodes: [],
            },
            {
              batch_id: 'b1',
              status: 'completed',
              batch_seq: 2,
              created_at: NOW_ISO,
              episodes: [],
            },
            {
              batch_id: 'b2',
              status: 'completed',
              batch_seq: 4,
              created_at: NOW_ISO,
              episodes: [],
            },
          ],
        }),
      );
    }
    return Promise.resolve(jsonResponse({}));
  });
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  await waitFor(() => expect(result.current.predictedSeq).toBe(5));
});

test('predictedSeq falls back to 1 when no batch exists today', async () => {
  vi.setSystemTime(PREDICTION_CLOCK);
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/batches')) {
      return Promise.resolve(
        jsonResponse({
          items: [
            {
              batch_id: 'b_old',
              status: 'completed',
              batch_seq: 7,
              created_at: OLD_ISO,
              episodes: [],
            },
          ],
        }),
      );
    }
    return Promise.resolve(jsonResponse({}));
  });
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  await waitFor(() => expect(result.current.predictedSeq).toBe(1));
});

test('predictedSeq stays null on a GET /batches failure (the UI then renders "next #1")', async () => {
  vi.setSystemTime(PREDICTION_CLOCK);
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/batches')) return Promise.reject(new Error('api down'));
    return Promise.resolve(jsonResponse({}));
  });
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  // The GET is fired on mount; give it a tick to reject, then confirm the catch
  // left the hint unset (ContextBar renders `predictedSeq ?? 1`).
  await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
  expect(result.current.predictedSeq).toBeNull();
});

// ---------------------------------------------------------------------------
// D-1 takeover: a server recording this screen isn't driving.
// ---------------------------------------------------------------------------

test('a server recording not started here surfaces as a takeover (operator + topics from the capture)', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/captures/cap_ext')) {
      return Promise.resolve(
        jsonResponse(
          captureBody('cap_ext', {
            topics: [
              { name: '/a', type: 'x' },
              { name: '/b', type: 'y' },
            ],
            operator: 'someone',
          }),
        ),
      );
    }
    if (url.includes('/captures'))
      return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
    if (url.includes('/record/status')) {
      return Promise.resolve(
        jsonResponse({
          capture_id: 'cap_ext',
          run_id: 'run_cap_ext',
          state: 'recording',
          live_capture_ids: ['cap_ext'],
          started_at: new Date().toISOString(),
          bytes: 2048,
        }),
      );
    }
    return Promise.resolve(jsonResponse({}));
  });
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  await waitFor(() => expect(result.current.takeover?.captureId).toBe('cap_ext'));
  // Not our capture (no persisted lastCaptureId) -> not resumed-own.
  expect(result.current.takeoverResumedOwn).toBe(false);
  expect(result.current.takeover?.bytes).toBe(2048);
  // Operator, topic count and the display run_id come from the capture
  // (RecordStatus carries none of them).
  await waitFor(() => expect(result.current.takeover?.operator).toBe('someone'));
  expect(result.current.takeover?.topicsCount).toBe(2);
  expect(result.current.takeover?.runLabel).toBe('run_cap_ext');
  expect(result.current.recorderState).toBe('recording');
});

// The singular `capture_id` keeps naming the last capture after a stop (§10),
// so a finished recorder must NOT read as a takeover. Only the live set can say
// what is live, and here it says nothing is.
test('a stopped recorder still naming its last capture_id is not a takeover', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/captures'))
      return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
    if (url.includes('/record/status'))
      return Promise.resolve(
        jsonResponse({
          capture_id: 'cap_last',
          run_id: 'run_cap_last',
          state: 'completed',
          live_capture_ids: [],
        }),
      );
    return Promise.resolve(jsonResponse({}));
  });
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  await waitFor(() => expect(result.current.recorderState).toBe('completed'));
  expect(result.current.takeover).toBeNull();
  expect(result.current.liveCaptures).toEqual([]);
});

// §10 rev.2.4: an absent `live_capture_ids` means the recorder is UNREACHABLE.
// Neither claim is allowed from that: not a takeover (we would be inventing
// one), and not "nothing is live" (we would be denying one).
test('a status with no live_capture_ids yields no takeover and a null live set', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/captures'))
      return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
    if (url.includes('/record/status'))
      return Promise.resolve(
        jsonResponse({ capture_id: 'cap_ext', run_id: 'run_x', state: 'recording' }),
      );
    return Promise.resolve(jsonResponse({}));
  });
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  await waitFor(() => expect(result.current.recorderState).toBe('recording'));
  expect(result.current.takeover).toBeNull();
  // Null, never [] — the two mean opposite things.
  expect(result.current.liveCaptures).toBeNull();
});

test('a reload of our own recording is a resumed-own takeover (lastCaptureId match)', async () => {
  window.localStorage.setItem(
    BATCH_STORAGE_KEY,
    JSON.stringify({
      lastCaptureId: 'cap_own',
      episodes: [],
      project: 'P',
      task: 'T',
      condition: 'C',
    }),
  );
  __rehydrateBatchStore();
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/captures/cap_own')) {
      return Promise.resolve(
        jsonResponse(captureBody('cap_own', { topics: [], operator: null })),
      );
    }
    if (url.includes('/captures'))
      return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
    if (url.includes('/record/status')) {
      return Promise.resolve(
        jsonResponse({
          capture_id: 'cap_own',
          run_id: 'run_cap_own',
          state: 'recording',
          live_capture_ids: ['cap_own'],
          started_at: new Date().toISOString(),
        }),
      );
    }
    return Promise.resolve(jsonResponse({}));
  });
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  await waitFor(() => expect(result.current.takeover?.captureId).toBe('cap_own'));
  expect(result.current.takeoverResumedOwn).toBe(true);
});

test('confirming a takeover stop POSTs /record/stop and closes the modal', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (
      url.includes('/record/stop') &&
      (init?.method ?? 'POST').toUpperCase() === 'POST'
    ) {
      return Promise.resolve(
        jsonResponse(captureBody('cap_ext', { state: 'completed' })),
      );
    }
    if (url.includes('/captures/cap_ext')) {
      return Promise.resolve(
        jsonResponse(captureBody('cap_ext', { topics: [], operator: null })),
      );
    }
    if (url.includes('/captures'))
      return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
    if (url.includes('/record/status')) {
      return Promise.resolve(
        jsonResponse({
          capture_id: 'cap_ext',
          run_id: 'run_cap_ext',
          state: 'recording',
          live_capture_ids: ['cap_ext'],
          started_at: new Date().toISOString(),
        }),
      );
    }
    return Promise.resolve(jsonResponse({}));
  });
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  await waitFor(() => expect(result.current.takeover?.captureId).toBe('cap_ext'));

  act(() => result.current.openTakeoverStopModal());
  expect(result.current.takeoverStopModalOpen).toBe(true);
  act(() => result.current.confirmTakeoverStop());
  await waitFor(() =>
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/record/stop'))).toBe(
      true,
    ),
  );
});

// ---------------------------------------------------------------------------
// D-3 unsaved-take recovery + stop-failure retry.
// ---------------------------------------------------------------------------

function unsavedCapturesFetch(present: () => boolean) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.includes('/captures/cap_unsaved/delete') && method === 'POST') {
      return Promise.resolve(
        jsonResponse(captureBody('cap_unsaved', { state: 'discarded' })),
      );
    }
    if (url.includes('/captures')) {
      // `review_revision: 0` is the server's own "never reviewed" (§4.1): the
      // recording stopped but nobody labeled it.
      const items = present()
        ? [
            captureBody('cap_unsaved', {
              state: 'completed',
              review_revision: 0,
              bytes: 8192,
              started_at: new Date(Date.now() - 60_000).toISOString(),
              ended_at: new Date().toISOString(),
            }),
          ]
        : [];
      return Promise.resolve(jsonResponse({ items, next_cursor: null }));
    }
    if (url.includes('/batches') && method === 'POST') {
      return Promise.resolve(jsonResponse({ batch_id: 'b', status: 'active' }, 201));
    }
    if (url.includes('/batches')) return Promise.resolve(jsonResponse({ items: [] }));
    return Promise.resolve(jsonResponse({}));
  });
}

test('detects a completed-but-unreviewed recent capture as an unsaved take, then labels it', async () => {
  unsavedCapturesFetch(() => true);
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  await waitFor(() =>
    expect(result.current.unsavedTake?.captureId).toBe('cap_unsaved'),
  );
  // The run_id is offered as the recording's readable name, not as its key.
  expect(result.current.unsavedTake?.runLabel).toBe('run_cap_unsaved');
  expect(result.current.unsavedTake?.bytes).toBe(8192);

  // Await act so the lazy ensureBatch() POST settles inside act (no stray update).
  await act(async () => {
    result.current.labelUnsavedTake();
  });
  // Drops into the result phase for that capture so the operator can label it.
  expect(result.current.phase).toBe('result');
  expect(result.current.currentRunLabel).toBe('run_cap_unsaved');
  // The capture being labeled is no longer offered as an unsaved take.
  expect(result.current.unsavedTake).toBeNull();
});

test('an already-reviewed capture is NOT offered as an unsaved take', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/captures'))
      // Reviewed once already (revision 1) — it is accounted for and must not
      // come back as a recovery offer.
      return Promise.resolve(
        jsonResponse({
          items: [
            captureBody('cap_done', {
              state: 'completed',
              review_revision: 1,
              started_at: new Date(Date.now() - 60_000).toISOString(),
            }),
          ],
          next_cursor: null,
        }),
      );
    if (url.includes('/batches')) return Promise.resolve(jsonResponse({ items: [] }));
    return Promise.resolve(jsonResponse({}));
  });
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
  // Give the scan a tick, then confirm it stays null (already accounted for).
  await new Promise((r) => setTimeout(r, 20));
  expect(result.current.unsavedTake).toBeNull();
});

test('discarding an unsaved take is one click with an automatic ledger reason', async () => {
  const fetchMock = unsavedCapturesFetch(() => true);
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  await waitFor(() =>
    expect(result.current.unsavedTake?.captureId).toBe('cap_unsaved'),
  );

  await act(async () => {
    result.current.discardUnsavedTake();
  });
  await waitFor(() => {
    const del = fetchMock.mock.calls.find(
      ([u, i]) =>
        String(u).includes('/captures/cap_unsaved/delete') && i?.method === 'POST',
    );
    expect(del).toBeTruthy();
    expect(JSON.parse(String((del![1] as RequestInit).body))).toEqual({
      kind: 'discard',
      reason: 'Collect recovery-banner discard of an unsaved take (no reason asked)',
    });
  });
  // Nothing opened along the way.
  expect(result.current.unsavedDiscard.kind).toBeNull();
});

// (The old "opening one discard dialog closes the other" test is gone with the
// dialogs themselves: both Collect discards are now one-click actions on
// different captures, so there is nothing to stack.)

test('dismissing an unsaved take hides it (Later)', async () => {
  unsavedCapturesFetch(() => true);
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  await waitFor(() =>
    expect(result.current.unsavedTake?.captureId).toBe('cap_unsaved'),
  );
  act(() => result.current.dismissUnsavedTake());
  expect(result.current.unsavedTake).toBeNull();
});

test('a failed stop stays in SAVING with a working Retry stop', async () => {
  let failStop = true;
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/record/start')) {
      return Promise.resolve(jsonResponse(captureBody('cap_s')));
    }
    if (url.includes('/record/stop')) {
      return failStop
        ? Promise.resolve(
            jsonResponse({ error: { code: 'io', message: 'disk busy' } }, 500),
          )
        : Promise.resolve(jsonResponse(captureBody('cap_s', { state: 'completed' })));
    }
    if (url.includes('/record/status')) {
      // While the stop is failing the recorder is still recording (and still
      // names the capture live); once it succeeds the capture finalises with a
      // clean integrity and an empty live set.
      return Promise.resolve(
        failStop
          ? jsonResponse({
              capture_id: 'cap_s',
              run_id: 'run_cap_s',
              state: 'recording',
              live_capture_ids: ['cap_s'],
            })
          : jsonResponse({
              capture_id: 'cap_s',
              run_id: 'run_cap_s',
              state: 'completed',
              live_capture_ids: [],
              integrity: 'ok',
            }),
      );
    }
    return Promise.resolve(jsonResponse({}));
  });

  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  act(() => result.current.startRecording());
  await waitFor(() => expect(result.current.phase).toBe('recording'));
  act(() => result.current.stopRecording());
  // The stop fails: stay in SAVING and surface the error (never snap forward).
  await waitFor(() => expect(result.current.stopError?.message).toBe('disk busy'));
  expect(result.current.phase).toBe('saving');

  // Retry succeeds → SAVING advances through QUICK CHECK to the result.
  failStop = false;
  const stopsBefore = fetchMock.mock.calls.filter(([u]) =>
    String(u).includes('/record/stop'),
  ).length;
  act(() => result.current.retryStop());
  await waitFor(() => expect(result.current.phase).toBe('result'), { timeout: 4000 });
  expect(
    fetchMock.mock.calls.filter(([u]) => String(u).includes('/record/stop')).length,
  ).toBe(stopsBefore + 1);
});

// ---------------------------------------------------------------------------
// Pre-arm (two-phase start) engine: while the operator sits ready, the machine
// keeps the recorder armed via /record/prepare — gated on recording.pre_arm
// and on the recorder actually being between recordings.
// ---------------------------------------------------------------------------

function preArmFetch({
  // A fresh recorder sits in `created`; there is no `idle` on the wire (§10).
  preArm = true,
  recorderState = 'created',
  statusExtra = {} as Record<string, unknown>,
} = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/config/recording')) {
      return Promise.resolve(
        jsonResponse({ config: { recording: { pre_arm: preArm } }, path: 'p' }),
      );
    }
    if (url.includes('/record/prepare')) {
      return Promise.resolve(
        jsonResponse({
          run_id: 'run_armed',
          capture_id: 'cap_armed',
          state: 'armed',
          disarm_at: null,
        }),
      );
    }
    if (url.includes('/record/status')) {
      return Promise.resolve(
        jsonResponse({
          run_id: null,
          capture_id: null,
          state: recorderState,
          live_capture_ids: [],
          ...statusExtra,
        }),
      );
    }
    return Promise.resolve(jsonResponse({}));
  });
}

test('pre-arms via /record/prepare while ready, mirroring the start selection', async () => {
  const fetchMock = preArmFetch();
  renderHook(() => useBatchMachine({ defaultTopics: ['/tf', '/joint_states'] }), {
    wrapper,
  });
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(([u]) => String(u).includes('/record/prepare')),
    ).toBe(true),
  );
  const call = fetchMock.mock.calls.find(([u]) =>
    String(u).includes('/record/prepare'),
  );
  // The prepare body mirrors the next start's topic selection — anything else
  // would arm a session the eventual start cannot claim.
  expect(JSON.parse(String(call![1]!.body))).toMatchObject({
    topics: ['/tf', '/joint_states'],
  });
});

test('does NOT pre-arm when recording.pre_arm is off', async () => {
  const fetchMock = preArmFetch({ preArm: false });
  renderHook(() => useBatchMachine({ defaultTopics: ['/tf'] }), { wrapper });
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(([u]) => String(u).includes('/config/recording')),
    ).toBe(true),
  );
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(([u]) => String(u).includes('/record/status')),
    ).toBe(true),
  );
  await new Promise((r) => setTimeout(r, 50));
  expect(
    fetchMock.mock.calls.some(([u]) => String(u).includes('/record/prepare')),
  ).toBe(false);
});

test('does NOT pre-arm while the server reports an active recording', async () => {
  const fetchMock = preArmFetch({
    recorderState: 'recording',
    statusExtra: {
      capture_id: 'cap_other',
      run_id: 'run_other',
      live_capture_ids: ['cap_other'],
    },
  });
  renderHook(() => useBatchMachine({ defaultTopics: ['/tf'] }), { wrapper });
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(([u]) => String(u).includes('/record/status')),
    ).toBe(true),
  );
  await new Promise((r) => setTimeout(r, 50));
  expect(
    fetchMock.mock.calls.some(([u]) => String(u).includes('/record/prepare')),
  ).toBe(false);
});

test('preArmed reflects the server-reported armed state, never a sent prepare', async () => {
  preArmFetch({
    recorderState: 'armed',
    statusExtra: {
      capture_id: 'cap_armed',
      live_capture_ids: ['cap_armed'],
      arming: {
        active: true,
        matched_topics: ['/tf'],
        missing_topics: [],
        disarm_at: new Date(Date.now() + 120_000).toISOString(),
      },
    },
  });
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: ['/tf'] }), {
    wrapper,
  });
  await waitFor(() => expect(result.current.preArmed).toBe(true));
  expect(result.current.recorderState).toBe('armed');
});

// M6 (qa-ui shots/08b): two unsaved takes can be pending at once — the recovery
// banner describing an older one, the result panel a newer one, each with its
// own Discard. "Later" dismissed only the take on screen, so the next one took
// its place instantly and the button read as broken.
test('"Later" hides every known unsaved take, not just the one on screen', async () => {
  const unsaved = (id: string, startedAt: string) => ({
    capture_id: id,
    run_id: `run_${id}`,
    state: 'completed',
    review_status: 'pending',
    review_revision: 0,
    started_at: startedAt,
    ended_at: startedAt,
    bytes: 1000,
  });
  const now = Date.now();
  const iso = (offsetMs: number) => new Date(now - offsetMs).toISOString();

  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/captures'))
      return Promise.resolve(
        jsonResponse({
          // Newest first, as the API returns them.
          items: [unsaved('cap_new', iso(10_000)), unsaved('cap_old', iso(60_000))],
          next_cursor: null,
        }),
      );
    return Promise.resolve(jsonResponse({}));
  });

  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });

  await waitFor(() => expect(result.current.unsavedTakeCount).toBe(2));
  // The banner describes the most recent one — the take most likely in mind.
  expect(result.current.unsavedTake?.captureId).toBe('cap_new');

  act(() => result.current.dismissUnsavedTake());

  // Both are gone: dismissing one only to meet the next is what made "Later"
  // look like it did nothing.
  await waitFor(() => expect(result.current.unsavedTake).toBeNull());
  expect(result.current.unsavedTakeCount).toBe(0);
});

// B1-RECOVERY (blocker): the outage ends and the recorder answers again with
// state:created / capture_id:null. The tab that lived through it flipped back
// to "RECORDING" with a FRESH 00:00:00 timer for a recording that no longer
// exists, and never self-corrected — a newly opened tab was correct, so the
// stale phase was purely client-local.
test('a recording does not resume when the recorder returns without it', async () => {
  let recorderAlive = true;
  let started = false;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/record/status')) {
      if (!recorderAlive) return Promise.reject(new Error('recorder unreachable'));
      return Promise.resolve(
        jsonResponse(
          started
            ? // Back up, and holding NOTHING: the take died during the outage.
              { capture_id: null, run_id: null, state: 'created', live_capture_ids: [] }
            : { capture_id: null, run_id: null, state: 'created', live_capture_ids: [] },
        ),
      );
    }
    if (url.includes('/record/start')) {
      started = true;
      return Promise.resolve(jsonResponse(captureBody('cap_lost')));
    }
    if (url.includes('/captures'))
      return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
    return Promise.resolve(jsonResponse({}));
  });

  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  act(() => result.current.startRecording());
  await waitFor(() => expect(result.current.phase).toBe('recording'));

  // The recorder dies, then comes back holding no capture.
  recorderAlive = false;
  await waitFor(() => expect(result.current.recorderUnreachable).toBe(true), {
    timeout: 10000,
  });
  recorderAlive = true;

  // It must NOT resume recording on stale client state alone.
  await waitFor(() => expect(result.current.phase).toBe('ready'), { timeout: 10000 });
  expect(result.current.recorderUnreachable).toBe(false);
}, 25000);

// The interrupted take is not lost — it exists server-side with whatever bytes
// it managed, and the operator is the only one who can say if they are worth
// keeping. It never appeared in the recovery banner at all before.
test('an interrupted take is offered for recovery', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/captures'))
      return Promise.resolve(
        jsonResponse({
          items: [
            {
              capture_id: 'cap_interrupted',
              run_id: 'run_x',
              state: 'interrupted',
              review_status: 'pending',
              review_revision: 0,
              started_at: new Date(Date.now() - 20_000).toISOString(),
              ended_at: new Date(Date.now() - 10_000).toISOString(),
              bytes: 4_000_000,
            },
          ],
          next_cursor: null,
        }),
      );
    return Promise.resolve(jsonResponse({}));
  });

  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });

  await waitFor(() =>
    expect(result.current.unsavedTake?.captureId).toBe('cap_interrupted'),
  );
  expect(result.current.unsavedTake?.bytes).toBe(4_000_000);
});

// The reason a take ended on its own is the whole question, and a toast is gone
// seconds later — the operator meets the take minutes afterwards. The banner
// carries it, preferring the recorder's OWN account where it wrote one.
test('an interrupted take carries WHY it ended, from the capture itself', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/captures'))
      return Promise.resolve(
        jsonResponse({
          items: [
            {
              capture_id: 'cap_i',
              run_id: 'run_i',
              state: 'interrupted',
              review_status: 'pending',
              review_revision: 0,
              started_at: new Date(Date.now() - 20_000).toISOString(),
              ended_at: new Date(Date.now() - 10_000).toISOString(),
              bytes: 10_000_000,
              error: {
                code: 'interrupted',
                message: 'recorder restarted while the capture was recording',
              },
            },
          ],
          next_cursor: null,
        }),
      );
    return Promise.resolve(jsonResponse({}));
  });

  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });

  await waitFor(() => expect(result.current.unsavedTake?.interrupted).toBe(true));
  expect(result.current.unsavedTake?.reason).toBe(
    'recorder restarted while the capture was recording',
  );
});

test('a merely-unsaved take is not labelled interrupted', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/captures'))
      return Promise.resolve(
        jsonResponse({
          items: [
            {
              capture_id: 'cap_c',
              state: 'completed',
              review_status: 'pending',
              review_revision: 0,
              started_at: new Date(Date.now() - 5_000).toISOString(),
              ended_at: new Date(Date.now() - 4_000).toISOString(),
              bytes: 1000,
            },
          ],
          next_cursor: null,
        }),
      );
    return Promise.resolve(jsonResponse({}));
  });

  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  await waitFor(() => expect(result.current.unsavedTake?.captureId).toBe('cap_c'));
  expect(result.current.unsavedTake?.interrupted).toBe(false);
  expect(result.current.unsavedTake?.reason).toBeNull();
});

// M6-PERSIST: the banner PROMISES "Later hides them all until a new one
// appears". An in-memory dismissal that a reload undoes breaks that promise in
// exactly the situation the operator hits it — they dismissed because they did
// not want to deal with those takes yet.
test('a dismissal survives a reload, and a NEW take still surfaces', async () => {
  const unsaved = (id: string) => ({
    capture_id: id,
    run_id: `run_${id}`,
    state: 'completed',
    review_status: 'pending',
    review_revision: 0,
    started_at: new Date(Date.now() - 5_000).toISOString(),
    ended_at: new Date(Date.now() - 4_000).toISOString(),
    bytes: 1000,
  });
  let items = [unsaved('cap_old')];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/captures'))
      return Promise.resolve(jsonResponse({ items, next_cursor: null }));
    return Promise.resolve(jsonResponse({}));
  });

  const first = renderHook(() => useBatchMachine({ defaultTopics: [] }), { wrapper });
  await waitFor(() => expect(first.result.current.unsavedTake).not.toBeNull());
  act(() => first.result.current.dismissUnsavedTake());
  await waitFor(() => expect(first.result.current.unsavedTake).toBeNull());
  first.unmount();

  // A reload: fresh hook, fresh query cache. The dismissal is read back from
  // storage rather than resurrecting the take.
  const second = renderHook(() => useBatchMachine({ defaultTopics: [] }), { wrapper });
  await waitFor(() => expect(second.result.current.unsavedTakeCount).toBe(0));
  expect(second.result.current.unsavedTake).toBeNull();

  // A take recorded AFTER the dismissal has an id nobody dismissed, so it
  // surfaces on its own — no expiry rule needed.
  items = [unsaved('cap_new'), unsaved('cap_old')];
  await waitFor(
    () => expect(second.result.current.unsavedTake?.captureId).toBe('cap_new'),
    { timeout: 20000 },
  );
}, 30000);

// ACCEPT blocker (qa-ui z1/z3): the normal Collect happy path left every good
// take `pending`, and Review's READY lane — correctly, the lane that needs no
// attention — offered nothing to click. The Datasets rail refuses anything not
// adopted, so a GOOD take could never enter a training set through the UI while
// a mediocre one (routed through NEEDS CHECK, where Mark OK adopts) could.
// "Save — success" on good data IS the judgment; a second ceremony elsewhere to
// restate it is the discard-retyping mistake again.
test('saving a good take as a success adopts it, so a dataset can take it', async () => {
  const { calls } = phase2Fetch({ captureId: 'cap_ad', batchId: 'batch_ad' });
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });

  act(() => result.current.startRecording());
  await waitFor(() => expect(result.current.phase).toBe('recording'));
  act(() => result.current.stopRecording());
  await waitFor(() => expect(result.current.phase).toBe('result'), { timeout: 4000 });
  // E-2 precondition: no verdict has settled, so this 'good' is the fallback —
  // the adoption below is proposed against data nobody has measured yet.
  expect(result.current.quickCheck.pending).toBe(true);
  expect(result.current.autoQuality).toBe('good');
  act(() => result.current.pickSuccess());
  act(() => result.current.confirmEpisode());
  await waitFor(() => expect(result.current.stats.nRecorded).toBe(1));

  const patch = calls.find((c) => c.url.includes('/review') && c.method === 'PATCH')!;
  expect(patch.body).toMatchObject({
    task_result: 'success',
    review_status: 'adopted',
  });
  // The operator overrode nothing, so quality is still the server's to derive —
  // and to correct, status included, once its verdict lands (§4.1). Claiming
  // 'operator' provenance here would freeze the guess as a human decision and
  // disable that correction. Adoption is a decision, not a quality claim.
  expect(patch.body).not.toHaveProperty('quality');
  expect(patch.body).not.toHaveProperty('quality_source');
});

test('a take the operator sent to needs-review is not adopted by saving it', async () => {
  const { calls } = phase2Fetch({ captureId: 'cap_nr', batchId: 'batch_nr' });
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });

  act(() => result.current.startRecording());
  await waitFor(() => expect(result.current.phase).toBe('recording'));
  act(() => result.current.stopRecording());
  await waitFor(() => expect(result.current.phase).toBe('result'), { timeout: 4000 });
  act(() => result.current.setQuality('review'));
  act(() => result.current.pickSuccess());
  act(() => result.current.confirmEpisode());
  await waitFor(() => expect(result.current.stats.nRecorded).toBe(1));

  const patch = calls.find((c) => c.url.includes('/review') && c.method === 'PATCH')!;
  // It goes to NEEDS CHECK, where including it is a separate, deliberate click.
  expect(patch.body).toMatchObject({
    task_result: 'success',
    quality: 'needs_review',
    review_status: 'pending',
  });
});

// The whole mapping in one place: which saves are a judgment the store should
// act on, and which are a label that leaves the decision open.
test('only a successful, good take is adopted by the save itself', () => {
  expect(collectReviewStatus('ok', 'good')).toBe('adopted');
  // A failed task is not an unusable recording, but it is not something to
  // train on either — the operator decides that in Review.
  expect(collectReviewStatus('fail', 'good')).toBe('pending');
  expect(collectReviewStatus('ok', 'review')).toBe('pending');
  expect(collectReviewStatus('fail', 'review')).toBe('pending');
  // "Not usable" is the same statement Review's exclude makes, either way round.
  expect(collectReviewStatus('ok', 'notusable')).toBe('excluded');
  expect(collectReviewStatus('fail', 'notusable')).toBe('excluded');
});
