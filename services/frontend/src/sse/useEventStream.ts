// Single SSE subscription (GET /api/v1/events) that fans events into the
// TanStack Query cache. Components read the cache (useQuery with the same keys)
// and re-render. Reconnection is handled by the browser-native EventSource,
// which automatically replays the last `id:` via the `Last-Event-ID` header;
// on an explicit `resync` event we invalidate so components refetch.
//
// We keep a rolling buffer of recent alerts in the cache so the Monitor tab can
// show an alert feed without its own state.

import { useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { queryKeys } from '../api/queryKeys';
import type {
  AlertEvent,
  AlertSnapshot,
  JobStatus,
  MetricsSnapshot,
  RecordStatus,
  RecordStatusEvent,
  TopicMetric,
  SessionLogEntry,
  SessionLogType,
} from '../api/types';
import { useUiStore } from '../store/uiStore';

const MAX_ALERTS = 100;
// Bounded session ring buffer for the Monitor "Logs" sub-view. Holds the last
// N *lifecycle* events (record_status / alert / job) received since the page
// opened — NOT the high-frequency `metrics` stream (that would be pure noise and
// is already shown as live charts). Newest-first, same as the alert buffer.
const MAX_LOG_ENTRIES = 500;

// Monotonic id source for log entries (session-local; only used as a React key).
let logSeq = 0;

/** Append one entry to the session event-log ring buffer (newest-first, capped). */
function appendLog(qc: QueryClient, type: SessionLogType, summary: string): void {
  const entry: SessionLogEntry = { id: logSeq++, ts: Date.now(), type, summary };
  qc.setQueryData<SessionLogEntry[]>(queryKeys.eventLog, (prev) =>
    [entry, ...(prev ?? [])].slice(0, MAX_LOG_ENTRIES),
  );
}

/**
 * Compact one-liner for a record_status event: state + run_id + capture_id.
 *
 * The run_id comes first because it is the name an operator recognises (§1:
 * display text), but the capture_id has to be on the line too — it is the key
 * every other surface uses, and a log entry that cannot be matched back to a
 * capture is worthless the moment two takes carry a similar display name.
 */
function summarizeRecordStatus(data: RecordStatusEvent): string {
  const parts: string[] = [data.state];
  if (data.run_id) parts.push(data.run_id);
  if (data.capture_id) parts.push(data.capture_id);
  return parts.join(' · ');
}

/** Compact one-liner for an alert snapshot: the first alert + a "+N more" tail. */
function summarizeAlertSnapshot(alerts: AlertEvent[]): string {
  const first = alerts[0]!;
  const value = first.value != null ? ` = ${first.value}` : '';
  const head = `${first.topic} ${first.metric}${value}`;
  return alerts.length > 1 ? `${head} (+${alerts.length - 1} more)` : head;
}

/** Compact one-liner for a job event: pipeline + state + the capture it is
 *  about. Every job is keyed by capture_id (§10.5) — it resolves its source as
 *  `objects/<capture_id>` — so that is what identifies the line. */
function summarizeJob(data: JobStatus): string {
  const parts = [data.pipeline, data.state];
  if (data.capture_id) parts.push(data.capture_id);
  return parts.join(' · ');
}

// How far through one capture's lifecycle a state is. Within a SINGLE capture
// the recorder only ever moves forward, so a lower rank arriving after a higher
// one is a stale event, not news. Across captures it says nothing (a new capture
// legitimately starts at `recording` after the previous one `completed`), which
// is why the guard below only applies when the capture_id matches.
//
// `created` is here because the recorder really does report it: its RunState
// still starts at `created` before anything is armed (rosbag2_recorder
// models.py), even though no capture row is ever in that state.
const STATE_RANK: Record<string, number> = {
  idle: 0,
  created: 1,
  armed: 2,
  recording: 3,
  stopping: 4,
  completed: 5,
  failed: 5,
  interrupted: 5,
};

/**
 * True when *data* would move the cached status BACKWARDS within the same
 * capture. Such an event must be dropped: rewinding to `recording` after the
 * stop landed makes the Collect screen believe a recording it is not driving is
 * running, and it shows the takeover card ("RECORDING IN PROGRESS") over a take
 * the operator has already stopped.
 *
 * The comparison is on capture_id, not run_id: §1 makes capture_id the identity
 * and run_id display text, and the orchestrator will even rewrite a colliding
 * run_id (`_unique_run_id`) — two captures can therefore share a display name,
 * and matching on it would drop the live one's `recording` event as a rewind of
 * the previous one's `completed`. An event that names no capture is never
 * treated as stale: without an identity we cannot say it is the same recording,
 * and dropping a real event hides a running capture.
 */
function isStaleRecordStatus(
  prev: RecordStatus | undefined,
  data: RecordStatusEvent,
): boolean {
  if (!prev?.capture_id || !data.capture_id) return false;
  if (prev.capture_id !== data.capture_id) return false;
  const before = STATE_RANK[prev.state ?? ''];
  const after = STATE_RANK[data.state ?? ''];
  if (before === undefined || after === undefined) return false;
  return after < before;
}

function applyRecordStatus(qc: QueryClient, data: RecordStatusEvent): void {
  // Merge onto the previous cache entry rather than replacing it. The arming
  // snapshot (OL-①.4) rides only on the post-arming `recording` event; a later
  // counters-only event omits it, so spreading `prev` first preserves the
  // last-known arming instead of wiping the poll/SSE value to undefined. An
  // explicit `null` from the backend still clears it (handled below).
  let dropped = false;
  qc.setQueryData<RecordStatus>(queryKeys.recordStatus, (prev) => {
    if (isStaleRecordStatus(prev, data)) {
      dropped = true;
      return prev;
    }
    const next: RecordStatus = {
      ...prev,
      run_id: data.run_id,
      state: data.state,
      message_count: data.message_count,
      bytes: data.bytes,
    };
    // capture_id is what the rest of the app keys on (§1); an event that names
    // one must replace the cached identity, or a new capture would inherit the
    // previous capture's id until the next poll. Same for started_at: it is the
    // elapsed timer's baseline, and keeping the previous capture's would count
    // a fresh recording from the wrong instant.
    if (data.capture_id !== undefined) next.capture_id = data.capture_id;
    if (data.started_at !== undefined) next.started_at = data.started_at;
    if (data.arming !== undefined) next.arming = data.arming;
    return next;
  });
  // Still logged when dropped — silently swallowing it would hide a real
  // ordering problem behind a UI that merely looks correct.
  appendLog(
    qc,
    'record_status',
    `${summarizeRecordStatus(data)}${dropped ? ' (stale — ignored)' : ''}`,
  );
}

/**
 * Write a metrics snapshot, dropping rows nothing downstream can use.
 *
 * The stream carries no schema, so a payload can be well-formed JSON with a
 * wrong-shaped field — and one such row used to reach every consumer. One did:
 * a non-string `name` threw inside the row sort (features/monitor
 * useMonitorRows), the throw escaped to the root error boundary, and the WHOLE
 * console went down — tab bar included, no recovery without a reload, for an
 * operator who was on Collect and had never opened Monitor.
 *
 * This is the first line of defence and the right place for it: meeting a
 * schema-less stream at ingest fixes every consumer at once, where hardening
 * one comparator would only protect one sort.
 *
 * Rows are DROPPED rather than repaired. A row whose `name` is not a string
 * cannot be keyed, matched to an expected Hz, or named on screen; coercing it
 * would invent a topic called "[object Object]" and put a fiction in a
 * monitoring table. But a reading that disappears in silence is its own small
 * dishonesty, so the count rides along on `malformed_dropped` and the Monitor
 * header says it out loud.
 */
function applyMetrics(qc: QueryClient, data: MetricsSnapshot): void {
  const incoming = Array.isArray(data?.topics) ? data.topics : [];
  const topics = incoming.filter(
    (t) => t != null && typeof (t as TopicMetric).name === 'string',
  );
  const dropped = incoming.length - topics.length;
  qc.setQueryData(queryKeys.metrics, {
    ...data,
    topics,
    ...(dropped > 0 ? { malformed_dropped: dropped } : {}),
  });
}

function applyAlert(qc: QueryClient, data: AlertSnapshot): void {
  // The `alert` event carries a snapshot { ts, alerts: [...] }, not a single
  // alert. Prepend the current alerts (skip empty snapshots).
  const incoming = data?.alerts ?? [];
  if (incoming.length === 0) return;
  qc.setQueryData<AlertEvent[]>(queryKeys.alerts, (prev) =>
    [...incoming, ...(prev ?? [])].slice(0, MAX_ALERTS),
  );
  appendLog(qc, 'alert', summarizeAlertSnapshot(incoming));
}

function applyJob(qc: QueryClient, data: JobStatus): void {
  qc.setQueryData(queryKeys.job(data.job_id), data);
  appendLog(qc, 'job', summarizeJob(data));
}

/** Parse + dispatch a single SSE message. Exported for unit testing. */
export function dispatchSseEvent(qc: QueryClient, type: string, raw: string): void {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return; // ignore malformed payloads
  }
  switch (type) {
    case 'record_status':
      applyRecordStatus(qc, data as RecordStatusEvent);
      break;
    case 'metrics':
      applyMetrics(qc, data as MetricsSnapshot);
      break;
    case 'alert':
      applyAlert(qc, data as AlertSnapshot);
      break;
    case 'job':
      applyJob(qc, data as JobStatus);
      break;
    case 'bridge': {
      // Orchestrator <-> monitor connectivity (the monitor runs ON the robot
      // in the cross-host split). Drives the header badge + offline notes.
      const bridge = data as { monitor?: string };
      useUiStore.getState().setMonitorBridge(bridge?.monitor === 'up' ? 'up' : 'down');
      break;
    }
    case 'resync':
      // Server signalled the client fell outside the ring buffer; refetch all.
      void qc.invalidateQueries();
      break;
    default:
      break;
  }
}

const EVENT_TYPES = [
  'record_status',
  'metrics',
  'alert',
  'job',
  'bridge',
  'resync',
] as const;

/**
 * Subscribe to the orchestrator SSE stream for the lifetime of the component.
 * `eventsUrl` is the absolute path from runtime config (endpoints.events).
 */
export function useEventStream(eventsUrl: string): void {
  const queryClient = useQueryClient();
  const setSseStatus = useUiStore((s) => s.setSseStatus);

  useEffect(() => {
    // EventSource is unavailable in some non-browser test envs; guard it.
    if (typeof EventSource === 'undefined') return;

    setSseStatus('connecting');
    const es = new EventSource(eventsUrl);

    es.onopen = () => setSseStatus('open');
    es.onerror = () => {
      // EventSource auto-reconnects (with Last-Event-ID) unless CLOSED.
      setSseStatus(es.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting');
    };

    const handlers = EVENT_TYPES.map((type) => {
      const handler = (ev: MessageEvent<string>) =>
        dispatchSseEvent(queryClient, type, ev.data);
      es.addEventListener(type, handler as EventListener);
      return { type, handler } as const;
    });

    // Default unnamed messages (some servers omit `event:`) -> ignore unless
    // they carry a recognizable shape; we keep this conservative.
    return () => {
      for (const { type, handler } of handlers) {
        es.removeEventListener(type, handler as EventListener);
      }
      es.close();
      setSseStatus('closed');
    };
  }, [eventsUrl, queryClient, setSseStatus]);
}
