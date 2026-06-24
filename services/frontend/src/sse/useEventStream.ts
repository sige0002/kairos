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
  JobStatus,
  MetricsSnapshot,
  RecordStatusEvent,
} from '../api/types';
import { useUiStore } from '../store/uiStore';

const MAX_ALERTS = 100;

function applyRecordStatus(qc: QueryClient, data: RecordStatusEvent): void {
  qc.setQueryData(queryKeys.recordStatus, {
    run_id: data.run_id,
    state: data.state,
    message_count: data.message_count,
    bytes: data.bytes,
  });
}

function applyMetrics(qc: QueryClient, data: MetricsSnapshot): void {
  qc.setQueryData(queryKeys.metrics, data);
}

function applyAlert(qc: QueryClient, data: AlertEvent): void {
  qc.setQueryData<AlertEvent[]>(queryKeys.alerts, (prev) => {
    const next = [data, ...(prev ?? [])];
    return next.slice(0, MAX_ALERTS);
  });
}

function applyJob(qc: QueryClient, data: JobStatus): void {
  qc.setQueryData(queryKeys.job(data.job_id), data);
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
      applyAlert(qc, data as AlertEvent);
      break;
    case 'job':
      applyJob(qc, data as JobStatus);
      break;
    case 'resync':
      // Server signalled the client fell outside the ring buffer; refetch all.
      void qc.invalidateQueries();
      break;
    default:
      break;
  }
}

const EVENT_TYPES = ['record_status', 'metrics', 'alert', 'job', 'resync'] as const;

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
