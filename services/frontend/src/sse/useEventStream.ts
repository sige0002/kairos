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

/** Compact one-liner for a record_status event: state + run_id. */
function summarizeRecordStatus(data: RecordStatusEvent): string {
  const run = data.run_id ? ` · ${data.run_id}` : '';
  return `${data.state}${run}`;
}

/** Compact one-liner for an alert snapshot: the first alert + a "+N more" tail. */
function summarizeAlertSnapshot(alerts: AlertEvent[]): string {
  const first = alerts[0]!;
  const value = first.value != null ? ` = ${first.value}` : '';
  const head = `${first.topic} ${first.metric}${value}`;
  return alerts.length > 1 ? `${head} (+${alerts.length - 1} more)` : head;
}

/** Compact one-liner for a job event: pipeline + state (+ run_id when present). */
function summarizeJob(data: JobStatus): string {
  const run = data.run_id ? ` · ${data.run_id}` : '';
  return `${data.pipeline} · ${data.state}${run}`;
}

function applyRecordStatus(qc: QueryClient, data: RecordStatusEvent): void {
  // Merge onto the previous cache entry rather than replacing it. The arming
  // snapshot (OL-①.4) rides only on the post-arming `recording` event; a later
  // counters-only event omits it, so spreading `prev` first preserves the
  // last-known arming instead of wiping the poll/SSE value to undefined. An
  // explicit `null` from the backend still clears it (handled below).
  qc.setQueryData<RecordStatus>(queryKeys.recordStatus, (prev) => {
    const next: RecordStatus = {
      ...prev,
      run_id: data.run_id,
      state: data.state,
      message_count: data.message_count,
      bytes: data.bytes,
    };
    if (data.arming !== undefined) next.arming = data.arming;
    return next;
  });
  appendLog(qc, 'record_status', summarizeRecordStatus(data));
}

function applyMetrics(qc: QueryClient, data: MetricsSnapshot): void {
  qc.setQueryData(queryKeys.metrics, data);
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
