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
  __resetBatchStore,
  __rehydrateBatchStore,
  EPISODES_PER_BATCH,
} from './useBatchMachine';
import {
  __clearEpisodeOutcomes,
  getEpisodeOutcome,
  saveEpisodeOutcome,
} from '../episodeBridge';

const BATCH_STORAGE_KEY = 'kairos.collect.batch';

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
  s = reducer(s, { type: 'START_FAILED', error: { code: null, message: 'boom' } });
  expect(s.phase).toBe('ready');
  expect(s.startError?.message).toBe('boom');
});

test('recording -> saving -> quickcheck -> result (Success pre-selected)', () => {
  let s = createState();
  s = reducer(s, { type: 'START_REQUESTED' });
  s = reducer(s, { type: 'START_SUCCEEDED', runId: null });
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
  s = reducer(s, { type: 'START_SUCCEEDED', runId: 'run_1' });
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
      runId: undefined,
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
    runId: undefined,
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

// The server may re-allocate index_in_batch on a save collision; adopting the
// returned value moves the chip to its true slot and lifts the monotone count.
test('ADOPT_EPISODE_INDEX moves the saved episode to the server-assigned slot', () => {
  let s = createState();
  s = { ...s, phase: 'result', pendingTask: 'ok', currentRunId: 'run_9' };
  s = reducer(s, { type: 'CONFIRM_EPISODE', quality: 'good' });
  expect(s.episodes[0]).toMatchObject({ index: 1, runId: 'run_9' });

  s = reducer(s, { type: 'ADOPT_EPISODE_INDEX', runId: 'run_9', index: 4 });
  expect(s.episodes[0]?.index).toBe(4);
  expect(s.recordedCount).toBe(4);

  // No-op for an unknown run or an unchanged index (same state reference).
  expect(
    reducer(s, { type: 'ADOPT_EPISODE_INDEX', runId: 'run_unknown', index: 9 }),
  ).toBe(s);
  expect(reducer(s, { type: 'ADOPT_EPISODE_INDEX', runId: 'run_9', index: 4 })).toBe(s);
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
  // The batch machine now lives in a module-level store (so it survives a
  // tab-switch unmount); reset it — and its localStorage mirror — between hook
  // tests so state can't leak from one test into the next.
  __resetBatchStore();
  // The Collect->Review outcome bridge accumulates across sessions; clear it so
  // a saved episode in one test can't leak into the next.
  __clearEpisodeOutcomes();
  // Reset the shared record-picker store so selection-resolution tests don't
  // leak customized state into each other.
  useUiStore.setState({
    activeTab: '',
    recordOperator: '',
    recordSelected: new Set<string>(),
    recordCustomized: false,
  });
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

  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
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
      return Promise.resolve(jsonResponse({ run_id: 'run_1', state: 'recording' }));
    }
    if (url.includes('/record/stop')) {
      return Promise.resolve(jsonResponse({ run_id: 'run_1', state: 'completed' }));
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

// ---------------------------------------------------------------------------
// Real recorder status: arming (matched/missing) + integrity (drop/fail).
// ---------------------------------------------------------------------------

test('/record/status arming (matched/missing) surfaces on machine.arming', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/record/status')) {
      return Promise.resolve(
        jsonResponse({
          run_id: 'run_7',
          state: 'recording',
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

test('a dropped-integrity run surfaces on machine.integrity + droppedMessages', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/record/start')) {
      return Promise.resolve(jsonResponse({ run_id: 'run_1', state: 'recording' }));
    }
    if (url.includes('/record/status')) {
      return Promise.resolve(
        jsonResponse({
          run_id: 'run_1',
          state: 'completed',
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

// Gating: an integrity report for a *different* run must never leak into the
// current episode's result. Before any start (currentRunId null) the status is
// ungated, so it reads through; once a start binds currentRunId to run_1, a
// run_OTHER report is dropped.
test('integrity is gated to the current run — a mismatched run_id is dropped after start', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/record/start')) {
      return Promise.resolve(jsonResponse({ run_id: 'run_1', state: 'recording' }));
    }
    if (url.includes('/record/status')) {
      return Promise.resolve(
        jsonResponse({
          run_id: 'run_OTHER',
          state: 'completed',
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
      return Promise.resolve(jsonResponse({ run_id: 'run_1', state: 'recording' }));
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

test('Discard: confirm deletes the run then re-records; a failed DELETE keeps the episode', async () => {
  let failDelete = false;
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (url.includes('/record/status')) {
      return Promise.resolve(
        jsonResponse({ run_id: 'run_9', state: 'completed', integrity: 'ok' }),
      );
    }
    if (url.includes('/record/start')) {
      return Promise.resolve(jsonResponse({ run_id: 'run_9', state: 'recording' }));
    }
    if (url.includes('/record/stop')) {
      return Promise.resolve(jsonResponse({ run_id: 'run_9', state: 'completed' }));
    }
    if (url.includes('/runs/run_9') && init?.method === 'DELETE') {
      return failDelete
        ? Promise.resolve(
            jsonResponse({ error: { code: 'BUSY', message: 'run locked' } }, 500),
          )
        : Promise.resolve(new Response(null, { status: 204 }));
    }
    return Promise.resolve(jsonResponse({}));
  });

  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  act(() => result.current.startRecording());
  await waitFor(() => expect(result.current.phase).toBe('recording'));
  act(() => result.current.stopRecording());
  await waitFor(() => expect(result.current.phase).toBe('result'), { timeout: 4000 });

  // A failing DELETE keeps the episode in the result phase and surfaces the error.
  failDelete = true;
  act(() => result.current.openDiscardModal());
  expect(result.current.discardModalOpen).toBe(true);
  expect(result.current.discardRunId).toBe('run_9');
  act(() => result.current.confirmDiscard());
  await waitFor(() => expect(result.current.discardError).toBeTruthy());
  expect(result.current.phase).toBe('result');

  // A succeeding DELETE hits DELETE /runs/run_9 and returns to ready (re-record).
  failDelete = false;
  act(() => result.current.confirmDiscard());
  await waitFor(() => expect(result.current.phase).toBe('ready'));
  expect(result.current.episodes).toHaveLength(0);
  expect(
    fetchMock.mock.calls.some(
      ([u, i]) => String(u).includes('/runs/run_9') && i?.method === 'DELETE',
    ),
  ).toBe(true);
});

// ---------------------------------------------------------------------------
// State survives a tab-switch unmount (module store) and a reload (localStorage).
// ---------------------------------------------------------------------------

/** Mock /record/start + /record/stop + /record/status for a given run id (drives
 *  one episode). The status carries integrity 'ok' so QUICK CHECK advances on the
 *  real signal instead of the fallback timer. */
function recordFlowFetch(runId: string) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/record/start')) {
      return Promise.resolve(jsonResponse({ run_id: runId, state: 'recording' }));
    }
    if (url.includes('/record/stop')) {
      return Promise.resolve(jsonResponse({ run_id: runId, state: 'completed' }));
    }
    if (url.includes('/record/status')) {
      return Promise.resolve(
        jsonResponse({ run_id: runId, state: 'completed', integrity: 'ok' }),
      );
    }
    return Promise.resolve(jsonResponse({}));
  });
}

// (a) A confirmed episode must survive the hook unmounting and remounting — the
// exact tab-switch the bug wiped (episode count back to 0/30).
test('confirmed episodes survive an unmount/remount (tab switch)', async () => {
  recordFlowFetch('run_1');
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

// (d) The result phase and its run_id are durable context — a mid-result-phase
// tab round-trip must keep both (so Discard / integrity gating still target the
// right run on return).
test('the result phase and its run_id survive an unmount/remount', async () => {
  recordFlowFetch('run_9');
  const { result, unmount } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });

  act(() => result.current.startRecording());
  await waitFor(() => expect(result.current.phase).toBe('recording'));
  act(() => result.current.stopRecording());
  await waitFor(() => expect(result.current.phase).toBe('result'), { timeout: 4000 });
  expect(result.current.discardRunId).toBe('run_9');

  unmount();
  const remounted = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  expect(remounted.result.current.phase).toBe('result');
  expect(remounted.result.current.discardRunId).toBe('run_9');
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
      // A stale volatile phase/run must be ignored on restore.
      phase: 'recording',
      currentRunId: 'run_stale',
      elapsedMs: 4200,
    }),
  );
  __rehydrateBatchStore();

  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  expect(result.current.phase).toBe('ready');
  expect(result.current.elapsedMs).toBe(0);
  expect(result.current.discardRunId).toBeNull();
  expect(result.current.stats.nRecorded).toBe(1);
});

// ---------------------------------------------------------------------------
// Phase 2 orchestrator API: batch create / episode POST / lifecycle PATCH /
// server restore, plus the API-down fallback to the local bridge.
// ---------------------------------------------------------------------------

interface Phase2Opts {
  runId?: string;
  batchId?: string;
  activeBatches?: unknown[];
  episodePostFails?: boolean;
  /** run_ids the server's `GET /runs` list reports as still existing — used by
   *  the phantom-batch reconcile (a seeded local batch is real only when its
   *  runs are here). Defaults to none. */
  runs?: string[];
}

/** Mocks the record + batches + episodes endpoints, capturing every request. */
function phase2Fetch(opts: Phase2Opts = {}) {
  const runId = opts.runId ?? 'run_1';
  const batchId = opts.batchId ?? 'batch_x';
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
    if (url.includes('/batches') && method === 'GET') {
      return Promise.resolve(jsonResponse({ items: opts.activeBatches ?? [] }));
    }
    if (url.includes('/episodes') && method === 'POST') {
      if (opts.episodePostFails) {
        return Promise.resolve(
          jsonResponse({ error: { code: 'io', message: 'down' } }, 500),
        );
      }
      return Promise.resolve(jsonResponse({ episode_id: 'ep_1', ...body }, 201));
    }
    // GET /runs (the list, not a /runs/{id} detail or DELETE) — the phantom
    // reconcile checks whether a seeded local batch's runs still exist here.
    if (method === 'GET' && /\/runs(\?|$)/.test(url)) {
      const items = (opts.runs ?? []).map((rid) => ({
        run_id: rid,
        state: 'completed',
      }));
      return Promise.resolve(jsonResponse({ items, total: items.length }));
    }
    if (url.includes('/record/status')) {
      return Promise.resolve(
        jsonResponse({ run_id: runId, state: 'completed', integrity: 'ok' }),
      );
    }
    if (url.includes('/record/start')) {
      return Promise.resolve(jsonResponse({ run_id: runId, state: 'recording' }));
    }
    if (url.includes('/record/stop')) {
      return Promise.resolve(jsonResponse({ run_id: runId, state: 'completed' }));
    }
    return Promise.resolve(jsonResponse({}));
  });
  return { calls };
}

test('starting a recording creates a server batch with the plan context', async () => {
  useUiStore.setState({ recordOperator: 'yuki' });
  const { calls } = phase2Fetch({ runId: 'run_1' });
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

test('saving an episode POSTs it with enum-mapped fields; success does not touch the bridge', async () => {
  const { calls } = phase2Fetch({ runId: 'run_ep', batchId: 'batch_ep' });
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

  await waitFor(() =>
    expect(calls.some((c) => c.url.includes('/episodes') && c.method === 'POST')).toBe(
      true,
    ),
  );
  const post = calls.find((c) => c.url.includes('/episodes') && c.method === 'POST')!;
  // Collect's 'fail' + a clean (integrity ok) recording map to the server
  // vocabulary; the operator didn't touch quality, so the source is the honest
  // 'quick_check' — NOT 'operator' (the D-2 provenance fix).
  expect(post.body).toMatchObject({
    batch_id: 'batch_ep',
    run_id: 'run_ep',
    index_in_batch: 1,
    task_result: 'failure',
    quality: 'good',
    quality_source: 'quick_check',
    failure_reason: 'Object dropped',
  });
  // Server accepted it → the browser bridge is not written.
  expect(getEpisodeOutcome('run_ep')).toBeNull();
});

// D-2: an operator override changes the quality AND records the honest
// 'operator' provenance; 'Not usable' maps to the server 'not_usable'.
test('an operator quality override sets quality + quality_source=operator', async () => {
  const { calls } = phase2Fetch({ runId: 'run_ov', batchId: 'batch_ov' });
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

  await waitFor(() =>
    expect(calls.some((c) => c.url.includes('/episodes') && c.method === 'POST')).toBe(
      true,
    ),
  );
  const post = calls.find((c) => c.url.includes('/episodes') && c.method === 'POST')!;
  expect(post.body).toMatchObject({
    task_result: 'success',
    quality: 'not_usable',
    quality_source: 'operator',
  });
  // 'not usable' has no local axis, so the strip/tallies record it as 'review'.
  expect(result.current.stats.nReview).toBe(1);
});

test('an episode POST failure falls back to the local bridge', async () => {
  phase2Fetch({ runId: 'run_fb', batchId: 'batch_fb', episodePostFails: true });
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

  // Server rejected → the outcome is preserved in the browser bridge so Review
  // can still show it via the fallback path.
  await waitFor(() => expect(getEpisodeOutcome('run_fb')).not.toBeNull());
  expect(getEpisodeOutcome('run_fb')).toMatchObject({
    quality: 'good',
    taskResult: 'ok',
    batchNum: 1,
    episodeIndex: 1,
  });
});

test('ending a batch early PATCHes the server batch to ended_early', async () => {
  const { calls } = phase2Fetch({ runId: 'run_e', batchId: 'batch_e' });
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
    runId: `r${i + 1}`,
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
  // The seeded batch's runs still exist server-side, so the phantom reconcile
  // leaves it intact (it's a real in-progress batch, not a stale ghost).
  const { calls } = phase2Fetch({
    runId: 'run_30',
    batchId: 'batch_full',
    runs: seed.map((e) => e.runId),
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
        episodes: [
          {
            index: 1,
            run_id: 'r1',
            task_result: 'success',
            quality: 'good',
            review_status: 'pending',
          },
          {
            index: 2,
            run_id: 'r2',
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

// ---------------------------------------------------------------------------
// Phantom batch (Apple P0): a local batch context whose runs were deleted
// server-side must not survive as fabricated counters on the hero screen.
// ---------------------------------------------------------------------------

// A stale batch persisted locally (batch 6, 3 recorded) whose runs no longer
// exist, and a server that reports no active batch and no runs, is discarded —
// the counters reset to the honest empty state.
test('a stale local batch is discarded when the server has no active batch and its runs are gone', async () => {
  window.localStorage.setItem(
    BATCH_STORAGE_KEY,
    JSON.stringify({
      batchSeq: 6,
      recordedCount: 3,
      batchId: 'batch_ghost',
      episodes: [
        { index: 1, quality: 'good', taskResult: 'ok', runId: 'ghost_1' },
        { index: 2, quality: 'good', taskResult: 'ok', runId: 'ghost_2' },
        { index: 3, quality: 'review', taskResult: 'fail', runId: 'ghost_3' },
      ],
      project: 'Bin Picking',
      task: 'Bin to Tray',
      condition: 'Bin: full',
    }),
  );
  __rehydrateBatchStore();
  // Server: no active batch (default empty activeBatches) and no runs at all.
  phase2Fetch({ runs: [] });
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

// Offline resilience: if the /runs check itself fails, the local batch is kept
// (we never discard a batch we couldn't prove is stale).
test('a local batch is kept when the runs check fails (API error → keep)', async () => {
  window.localStorage.setItem(
    BATCH_STORAGE_KEY,
    JSON.stringify({
      batchSeq: 6,
      recordedCount: 3,
      batchId: 'batch_maybe',
      episodes: [
        { index: 1, quality: 'good', taskResult: 'ok', runId: 'x1' },
        { index: 2, quality: 'good', taskResult: 'ok', runId: 'x2' },
        { index: 3, quality: 'good', taskResult: 'ok', runId: 'x3' },
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
    if (method === 'GET' && /\/runs(\?|$)/.test(url)) {
      // The runs check errors — we must NOT clear the local batch.
      return Promise.resolve(
        jsonResponse({ error: { code: 'io', message: 'down' } }, 500),
      );
    }
    return Promise.resolve(jsonResponse({}));
  });
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });

  // Wait until the reconcile has attempted (and failed) the runs check …
  await waitFor(() =>
    expect(calls.some((c) => /GET .*\/runs(\?|$)/.test(c))).toBe(true),
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
      episodes: [{ index: 1, quality: 'good', taskResult: 'ok', runId: 'old_1' }],
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
        episodes: [
          {
            index: 5,
            run_id: 'r5',
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
        episodes: [
          // … but one was deleted in Review, so only 2 survive (index 2 gone).
          {
            index: 1,
            run_id: 'r1',
            task_result: 'success',
            quality: 'good',
            review_status: 'adopted',
          },
          {
            index: 3,
            run_id: 'r3',
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
        episodes: [
          {
            index: 1,
            run_id: 'r1',
            task_result: 'success',
            quality: 'good',
            review_status: 'pending',
          },
          {
            index: 2,
            run_id: 'r2',
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
    runId: `r${i + 1}`,
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
        episodes: [
          {
            index: 1,
            run_id: 'r1',
            task_result: 'success',
            quality: 'good',
            review_status: 'pending',
          },
          {
            index: 2,
            run_id: 'r2',
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
    runId: `r${i + 1}`,
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
        episodes: [
          {
            index: 1,
            run_id: 'r1',
            task_result: 'success',
            quality: 'good',
            review_status: 'pending',
          },
          {
            index: 2,
            run_id: 'r2',
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

test('discarding a run removes its bridge entry (no stale outcome lingers)', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (url.includes('/record/status')) {
      return Promise.resolve(
        jsonResponse({ run_id: 'run_disc', state: 'completed', integrity: 'ok' }),
      );
    }
    if (url.includes('/record/start')) {
      return Promise.resolve(jsonResponse({ run_id: 'run_disc', state: 'recording' }));
    }
    if (url.includes('/record/stop')) {
      return Promise.resolve(jsonResponse({ run_id: 'run_disc', state: 'completed' }));
    }
    if (url.includes('/runs/run_disc') && init?.method === 'DELETE') {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return Promise.resolve(jsonResponse({}));
  });

  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  act(() => result.current.startRecording());
  await waitFor(() => expect(result.current.phase).toBe('recording'));
  act(() => result.current.stopRecording());
  await waitFor(() => expect(result.current.phase).toBe('result'), { timeout: 4000 });

  // Seed a bridge entry for this run (defensive: prove Discard actually removes it).
  saveEpisodeOutcome('run_disc', {
    quality: 'good',
    taskResult: 'ok',
    batchNum: 1,
    episodeIndex: 1,
    savedAt: Date.now(),
  });
  expect(getEpisodeOutcome('run_disc')).not.toBeNull();

  act(() => result.current.openDiscardModal());
  act(() => result.current.confirmDiscard());
  await waitFor(() => expect(result.current.phase).toBe('ready'));
  expect(getEpisodeOutcome('run_disc')).toBeNull();
  expect(
    fetchMock.mock.calls.some(
      ([u, i]) => String(u).includes('/runs/run_disc') && i?.method === 'DELETE',
    ),
  ).toBe(true);
});

// ---------------------------------------------------------------------------
// Batch reset: close the current batch, counts → 0/30, recordings kept.
// ---------------------------------------------------------------------------

test('resetBatch clears the counts, PATCHes the batch ended_early=reset, and deletes nothing', async () => {
  const { calls } = phase2Fetch({ runId: 'run_r', batchId: 'batch_r' });
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
  const { calls } = phase2Fetch({ runId: 'run_r', batchId: 'batch_r' });
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

test('reset works with the API down (local-only reset, recordings untouched)', async () => {
  // /batches and /episodes reject; /record works so we can record locally.
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/batches')) return Promise.reject(new Error('api down'));
    if (url.includes('/episodes')) return Promise.reject(new Error('api down'));
    if (url.includes('/record/status')) {
      return Promise.resolve(
        jsonResponse({ run_id: 'run_x', state: 'completed', integrity: 'ok' }),
      );
    }
    if (url.includes('/record/start')) {
      return Promise.resolve(jsonResponse({ run_id: 'run_x', state: 'recording' }));
    }
    if (url.includes('/record/stop')) {
      return Promise.resolve(jsonResponse({ run_id: 'run_x', state: 'completed' }));
    }
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

  // Reset still works locally even though every batch/episode call failed.
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

const NOW_ISO = new Date().toISOString();
// ~2 days back — safely a prior LOCAL calendar day regardless of time-of-day.
const OLD_ISO = new Date(Date.now() - 2 * 86_400_000).toISOString();

test("predictedSeq = 1 + max(batch_seq) among today's batches (older days excluded)", async () => {
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

test('a server recording not started here surfaces as a takeover (operator + topics from run detail)', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/runs/run_ext')) {
      return Promise.resolve(
        jsonResponse({
          run_id: 'run_ext',
          state: 'recording',
          topics: [
            { name: '/a', type: 'x' },
            { name: '/b', type: 'y' },
          ],
          operator: 'someone',
        }),
      );
    }
    if (url.includes('/record/status')) {
      return Promise.resolve(
        jsonResponse({
          run_id: 'run_ext',
          state: 'recording',
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
  await waitFor(() => expect(result.current.takeover?.runId).toBe('run_ext'));
  // Not our run (no persisted lastRunId) → not resumed-own.
  expect(result.current.takeoverResumedOwn).toBe(false);
  expect(result.current.takeover?.bytes).toBe(2048);
  // Operator + topic count come from the run detail (RecordStatus carries neither).
  await waitFor(() => expect(result.current.takeover?.operator).toBe('someone'));
  expect(result.current.takeover?.topicsCount).toBe(2);
  expect(result.current.recorderState).toBe('recording');
});

test('a reload of our own recording is a resumed-own takeover (lastRunId match)', async () => {
  window.localStorage.setItem(
    BATCH_STORAGE_KEY,
    JSON.stringify({
      lastRunId: 'run_own',
      episodes: [],
      project: 'P',
      task: 'T',
      condition: 'C',
    }),
  );
  __rehydrateBatchStore();
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/runs/run_own')) {
      return Promise.resolve(
        jsonResponse({
          run_id: 'run_own',
          state: 'recording',
          topics: [],
          operator: null,
        }),
      );
    }
    if (url.includes('/record/status')) {
      return Promise.resolve(
        jsonResponse({
          run_id: 'run_own',
          state: 'recording',
          started_at: new Date().toISOString(),
        }),
      );
    }
    return Promise.resolve(jsonResponse({}));
  });
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  await waitFor(() => expect(result.current.takeover?.runId).toBe('run_own'));
  expect(result.current.takeoverResumedOwn).toBe(true);
});

test('confirming a takeover stop POSTs /record/stop and closes the modal', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (
      url.includes('/record/stop') &&
      (init?.method ?? 'POST').toUpperCase() === 'POST'
    ) {
      return Promise.resolve(jsonResponse({ run_id: 'run_ext', state: 'completed' }));
    }
    if (url.includes('/runs/run_ext')) {
      return Promise.resolve(
        jsonResponse({
          run_id: 'run_ext',
          state: 'recording',
          topics: [],
          operator: null,
        }),
      );
    }
    if (url.includes('/record/status')) {
      return Promise.resolve(
        jsonResponse({
          run_id: 'run_ext',
          state: 'recording',
          started_at: new Date().toISOString(),
        }),
      );
    }
    return Promise.resolve(jsonResponse({}));
  });
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  await waitFor(() => expect(result.current.takeover?.runId).toBe('run_ext'));

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

function unsavedRunsFetch(present: () => boolean) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.includes('/runs/run_unsaved') && method === 'DELETE') {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (url.includes('/runs')) {
      const items = present()
        ? [
            {
              run_id: 'run_unsaved',
              state: 'completed',
              started_at: new Date(Date.now() - 60_000).toISOString(),
              ended_at: new Date().toISOString(),
            },
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

test('detects a completed-but-unlabeled recent run as an unsaved take, then labels it', async () => {
  unsavedRunsFetch(() => true);
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  await waitFor(() => expect(result.current.unsavedTake?.runId).toBe('run_unsaved'));

  // Await act so the lazy ensureBatch() POST settles inside act (no stray update).
  await act(async () => {
    result.current.labelUnsavedTake();
  });
  // Drops into the result phase for that run so the operator can label it.
  expect(result.current.phase).toBe('result');
  expect(result.current.discardRunId).toBe('run_unsaved');
  // The run being labeled is no longer offered as an unsaved take.
  expect(result.current.unsavedTake).toBeNull();
});

test('a run with a bridge outcome is NOT offered as an unsaved take', async () => {
  saveEpisodeOutcome('run_unsaved', {
    quality: 'good',
    taskResult: 'ok',
    batchNum: 1,
    episodeIndex: 1,
    savedAt: Date.now(),
  });
  unsavedRunsFetch(() => true);
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
  // Give the scan a tick, then confirm it stays null (already accounted for).
  await new Promise((r) => setTimeout(r, 20));
  expect(result.current.unsavedTake).toBeNull();
});

test('discarding an unsaved take DELETEs the run', async () => {
  const fetchMock = unsavedRunsFetch(() => true);
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  await waitFor(() => expect(result.current.unsavedTake?.runId).toBe('run_unsaved'));

  act(() => result.current.discardUnsavedTake());
  expect(result.current.unsavedDiscardModalOpen).toBe(true);
  act(() => result.current.confirmDiscardUnsavedTake());
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(
        ([u, i]) => String(u).includes('/runs/run_unsaved') && i?.method === 'DELETE',
      ),
    ).toBe(true),
  );
});

test('dismissing an unsaved take hides it (Later)', async () => {
  unsavedRunsFetch(() => true);
  const { result } = renderHook(() => useBatchMachine({ defaultTopics: [] }), {
    wrapper,
  });
  await waitFor(() => expect(result.current.unsavedTake?.runId).toBe('run_unsaved'));
  act(() => result.current.dismissUnsavedTake());
  expect(result.current.unsavedTake).toBeNull();
});

test('a failed stop stays in SAVING with a working Retry stop', async () => {
  let failStop = true;
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/record/start')) {
      return Promise.resolve(jsonResponse({ run_id: 'run_s', state: 'recording' }));
    }
    if (url.includes('/record/stop')) {
      return failStop
        ? Promise.resolve(
            jsonResponse({ error: { code: 'io', message: 'disk busy' } }, 500),
          )
        : Promise.resolve(jsonResponse({ run_id: 'run_s', state: 'completed' }));
    }
    if (url.includes('/record/status')) {
      // While the stop is failing the recorder is still recording; once it
      // succeeds the run finalises with a clean integrity.
      return Promise.resolve(
        failStop
          ? jsonResponse({ run_id: 'run_s', state: 'recording' })
          : jsonResponse({ run_id: 'run_s', state: 'completed', integrity: 'ok' }),
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
