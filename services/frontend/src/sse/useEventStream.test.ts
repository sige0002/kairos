import { QueryClient } from '@tanstack/react-query';
import { expect, test } from 'vitest';
import { queryKeys } from '../api/queryKeys';
import type {
  AlertEvent,
  MetricsSnapshot,
  RecordStatus,
  RecordStatusEvent,
  SessionLogEntry,
} from '../api/types';
import { dispatchSseEvent } from './useEventStream';

test('metrics event writes the metrics query cache', () => {
  const qc = new QueryClient();
  // Real backend field names (see topic_monitor TopicMetrics): name + hz.
  const snapshot: MetricsSnapshot = {
    ts: '2026-06-24T00:00:00Z',
    window_s: 5,
    topics: [{ name: '/camera/head/image_raw', hz: 29.7, bandwidth_bps: 2_000_000 }],
  };
  dispatchSseEvent(qc, 'metrics', JSON.stringify(snapshot));
  expect(qc.getQueryData<MetricsSnapshot>(queryKeys.metrics)).toEqual(snapshot);
});

test('alert snapshots accumulate newest-first in the alerts cache', () => {
  const qc = new QueryClient();
  // Each `alert` event is a snapshot { ts, alerts: [...] }, not a single alert.
  const a1: AlertEvent = {
    topic: '/a',
    metric: 'hz',
    op: 'lt',
    threshold: 5,
    value: 1,
    state: 'firing',
  };
  const a2: AlertEvent = {
    topic: '/b',
    metric: 'loss',
    op: 'gt',
    threshold: 1,
    value: 9,
    state: 'firing',
  };
  dispatchSseEvent(qc, 'alert', JSON.stringify({ ts: 't1', alerts: [a1] }));
  dispatchSseEvent(qc, 'alert', JSON.stringify({ ts: 't2', alerts: [a2] }));
  const alerts = qc.getQueryData<AlertEvent[]>(queryKeys.alerts);
  expect(alerts?.[0]).toEqual(a2);
  expect(alerts?.[1]).toEqual(a1);
});

test('empty alert snapshots do not clobber the alerts cache', () => {
  const qc = new QueryClient();
  const a1: AlertEvent = { topic: '/a', metric: 'hz', op: 'lt', threshold: 5 };
  dispatchSseEvent(qc, 'alert', JSON.stringify({ ts: 't1', alerts: [a1] }));
  dispatchSseEvent(qc, 'alert', JSON.stringify({ ts: 't2', alerts: [] }));
  expect(qc.getQueryData<AlertEvent[]>(queryKeys.alerts)).toEqual([a1]);
});

test('record_status event writes the record status cache, capture_id included', () => {
  const qc = new QueryClient();
  const ev: RecordStatusEvent = {
    capture_id: 'cap-9',
    run_id: 'run-9',
    state: 'recording',
    message_count: 5,
    started_at: '2026-08-02T10:00:00Z',
  };
  dispatchSseEvent(qc, 'record_status', JSON.stringify(ev));
  expect(qc.getQueryData(queryKeys.recordStatus)).toMatchObject({
    capture_id: 'cap-9',
    run_id: 'run-9',
    state: 'recording',
    message_count: 5,
    started_at: '2026-08-02T10:00:00Z',
  });
});

// The elapsed timer's baseline rides on the event (§10). Keeping the previous
// capture's started_at would count a fresh recording from the wrong instant —
// on screen, a brand-new take that opens at hours elapsed.
test('a new capture replaces the cached identity and start time', () => {
  const qc = new QueryClient();
  dispatchSseEvent(
    qc,
    'record_status',
    JSON.stringify({
      capture_id: 'cap-9',
      run_id: 'run-9',
      state: 'completed',
      started_at: '2026-08-02T10:00:00Z',
    }),
  );
  dispatchSseEvent(
    qc,
    'record_status',
    JSON.stringify({
      capture_id: 'cap-10',
      run_id: 'run-10',
      state: 'recording',
      started_at: '2026-08-02T11:30:00Z',
    }),
  );
  const cached = qc.getQueryData<RecordStatus>(queryKeys.recordStatus);
  expect(cached?.capture_id).toBe('cap-10');
  expect(cached?.started_at).toBe('2026-08-02T11:30:00Z');
});

// OL-①.4: the arming snapshot rides on the post-arming `recording` event and
// must reach the recordStatus cache (the SSE half of the deliverable).
test('record_status event carrying arming propagates it into the cache', () => {
  const qc = new QueryClient();
  const ev: RecordStatusEvent = {
    run_id: 'run-9',
    state: 'recording',
    message_count: 0,
    bytes: 0,
    arming: { active: false, matched_topics: ['/a'], missing_topics: ['/b'] },
  };
  dispatchSseEvent(qc, 'record_status', JSON.stringify(ev));
  const cached = qc.getQueryData<RecordStatus>(queryKeys.recordStatus);
  expect(cached?.arming).toEqual({
    active: false,
    matched_topics: ['/a'],
    missing_topics: ['/b'],
  });
});

// Regression: a later counters-only record_status event (no arming) must NOT
// wipe a previously-known arming value — merge, don't clobber.
test('a record_status event without arming preserves a prior arming value', () => {
  const qc = new QueryClient();
  const withArming: RecordStatusEvent = {
    run_id: 'run-9',
    state: 'recording',
    message_count: 0,
    bytes: 0,
    arming: { active: false, matched_topics: ['/a'], missing_topics: ['/b'] },
  };
  dispatchSseEvent(qc, 'record_status', JSON.stringify(withArming));

  const countersOnly: RecordStatusEvent = {
    run_id: 'run-9',
    state: 'recording',
    message_count: 42,
    bytes: 1024,
  };
  dispatchSseEvent(qc, 'record_status', JSON.stringify(countersOnly));

  const cached = qc.getQueryData<RecordStatus>(queryKeys.recordStatus);
  expect(cached?.message_count).toBe(42);
  expect(cached?.bytes).toBe(1024);
  expect(cached?.arming).toEqual({
    active: false,
    matched_topics: ['/a'],
    missing_topics: ['/b'],
  });
});

// Regression: a stale `recording` event landing after the stop must not rewind
// the cache. The Collect screen reads this cache to decide whether a recording
// it is NOT driving is running, so a rewind puts the takeover card
// ("RECORDING IN PROGRESS") over a take the operator already stopped.
test('a record_status event that rewinds the SAME capture is dropped', () => {
  const qc = new QueryClient();
  const recording: RecordStatusEvent = {
    capture_id: 'cap-9',
    run_id: 'run-9',
    state: 'recording',
    message_count: 10,
  };
  const completed: RecordStatusEvent = {
    capture_id: 'cap-9',
    run_id: 'run-9',
    state: 'completed',
    message_count: 99,
  };
  dispatchSseEvent(qc, 'record_status', JSON.stringify(recording));
  dispatchSseEvent(qc, 'record_status', JSON.stringify(completed));
  // ...and now the stale one arrives late.
  dispatchSseEvent(qc, 'record_status', JSON.stringify(recording));

  const cached = qc.getQueryData<RecordStatus>(queryKeys.recordStatus);
  expect(cached?.state).toBe('completed');
  expect(cached?.message_count).toBe(99);
});

// The guard is per-CAPTURE: a new capture legitimately starts recording after
// the previous one completed, and must not be mistaken for a rewind.
test('a new capture may go recording right after the previous one completed', () => {
  const qc = new QueryClient();
  dispatchSseEvent(
    qc,
    'record_status',
    JSON.stringify({
      capture_id: 'cap-9',
      run_id: 'run-9',
      state: 'completed',
      message_count: 99,
    }),
  );
  dispatchSseEvent(
    qc,
    'record_status',
    JSON.stringify({
      capture_id: 'cap-10',
      run_id: 'run-10',
      state: 'recording',
      message_count: 0,
    }),
  );
  const cached = qc.getQueryData<RecordStatus>(queryKeys.recordStatus);
  expect(cached?.capture_id).toBe('cap-10');
  expect(cached?.state).toBe('recording');
});

// §1: run_id is display text and the orchestrator rewrites collisions, so two
// captures CAN carry a similar name. Keying the guard on it would drop the live
// capture's `recording` event as a rewind of the finished one's `completed` —
// the live recording would then be invisible until the next poll.
test('a same-named run on a different capture is not treated as a rewind', () => {
  const qc = new QueryClient();
  dispatchSseEvent(
    qc,
    'record_status',
    JSON.stringify({ capture_id: 'cap-9', run_id: 'run_20260802_120000', state: 'completed' }),
  );
  dispatchSseEvent(
    qc,
    'record_status',
    JSON.stringify({ capture_id: 'cap-10', run_id: 'run_20260802_120000', state: 'recording' }),
  );
  const cached = qc.getQueryData<RecordStatus>(queryKeys.recordStatus);
  expect(cached?.state).toBe('recording');
  expect(cached?.capture_id).toBe('cap-10');
});

// Without an identity on both sides there is no "same capture" to compare, and
// dropping a real event would hide a running recording — so nothing is dropped.
test('an event with no capture_id is never dropped as stale', () => {
  const qc = new QueryClient();
  dispatchSseEvent(qc, 'record_status', JSON.stringify({ run_id: 'run-9', state: 'completed' }));
  dispatchSseEvent(qc, 'record_status', JSON.stringify({ run_id: 'run-9', state: 'recording' }));
  expect(qc.getQueryData<RecordStatus>(queryKeys.recordStatus)?.state).toBe('recording');
});

test('malformed payloads are ignored', () => {
  const qc = new QueryClient();
  dispatchSseEvent(qc, 'metrics', 'not json');
  expect(qc.getQueryData(queryKeys.metrics)).toBeUndefined();
});

test('lifecycle events append to the session event-log ring buffer (newest-first)', () => {
  const qc = new QueryClient();
  dispatchSseEvent(
    qc,
    'record_status',
    JSON.stringify({ capture_id: 'cap-9', run_id: 'run-9', state: 'recording' }),
  );
  dispatchSseEvent(
    qc,
    'alert',
    JSON.stringify({ ts: 't', alerts: [{ topic: '/a', metric: 'hz', threshold: 5, value: 1 }] }),
  );
  // Jobs are keyed by capture_id (§10.5): the source they resolve is
  // objects/<capture_id>, so that is what identifies the line.
  dispatchSseEvent(
    qc,
    'job',
    JSON.stringify({
      job_id: 'j1',
      pipeline: 'fast_validation',
      state: 'succeeded',
      capture_id: 'cap-9',
    }),
  );
  const log = qc.getQueryData<SessionLogEntry[]>(queryKeys.eventLog);
  expect(log).toHaveLength(3);
  // Newest-first: the job event is at the head.
  expect(log?.[0]).toMatchObject({ type: 'job', summary: 'fast_validation · succeeded · cap-9' });
  expect(log?.[1]).toMatchObject({ type: 'alert', summary: '/a hz = 1' });
  // run_id first (the name an operator recognises), capture_id after it so the
  // line can still be matched to a capture.
  expect(log?.[2]).toMatchObject({
    type: 'record_status',
    summary: 'recording · run-9 · cap-9',
  });
});

// A dropped event still gets a log line: swallowing it silently would hide a
// real ordering problem behind a UI that merely looks correct.
test('a stale record_status is logged as ignored, not hidden', () => {
  const qc = new QueryClient();
  dispatchSseEvent(
    qc,
    'record_status',
    JSON.stringify({ capture_id: 'cap-9', run_id: 'run-9', state: 'completed' }),
  );
  dispatchSseEvent(
    qc,
    'record_status',
    JSON.stringify({ capture_id: 'cap-9', run_id: 'run-9', state: 'recording' }),
  );
  const log = qc.getQueryData<SessionLogEntry[]>(queryKeys.eventLog);
  expect(log?.[0]?.summary).toBe('recording · run-9 · cap-9 (stale — ignored)');
});

test('metrics events are NOT logged (they would be pure noise)', () => {
  const qc = new QueryClient();
  dispatchSseEvent(qc, 'metrics', JSON.stringify({ topics: [{ name: '/a', hz: 10 }] }));
  expect(qc.getQueryData<SessionLogEntry[]>(queryKeys.eventLog)).toBeUndefined();
});

test('alert log summary counts additional alerts in the snapshot', () => {
  const qc = new QueryClient();
  dispatchSseEvent(
    qc,
    'alert',
    JSON.stringify({
      ts: 't',
      alerts: [
        { topic: '/a', metric: 'hz', threshold: 5, value: 1 },
        { topic: '/b', metric: 'hz', threshold: 5, value: 2 },
      ],
    }),
  );
  const log = qc.getQueryData<SessionLogEntry[]>(queryKeys.eventLog);
  expect(log?.[0]?.summary).toBe('/a hz = 1 (+1 more)');
});

test('bridge events drive the monitorBridge ui state', async () => {
  const { useUiStore } = await import('../store/uiStore');
  const qc = new QueryClient();
  expect(useUiStore.getState().monitorBridge).toBeNull();
  dispatchSseEvent(qc, 'bridge', JSON.stringify({ monitor: 'down' }));
  expect(useUiStore.getState().monitorBridge).toBe('down');
  dispatchSseEvent(qc, 'bridge', JSON.stringify({ monitor: 'up' }));
  expect(useUiStore.getState().monitorBridge).toBe('up');
  useUiStore.getState().setMonitorBridge(null);
});
