import { QueryClient } from '@tanstack/react-query';
import { expect, test } from 'vitest';
import { queryKeys } from '../api/queryKeys';
import type { AlertEvent, MetricsSnapshot, RecordStatusEvent } from '../api/types';
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

test('record_status event writes the record status cache', () => {
  const qc = new QueryClient();
  const ev: RecordStatusEvent = {
    run_id: 'run-9',
    state: 'recording',
    message_count: 5,
  };
  dispatchSseEvent(qc, 'record_status', JSON.stringify(ev));
  expect(qc.getQueryData(queryKeys.recordStatus)).toMatchObject({
    run_id: 'run-9',
    state: 'recording',
    message_count: 5,
  });
});

test('malformed payloads are ignored', () => {
  const qc = new QueryClient();
  dispatchSseEvent(qc, 'metrics', 'not json');
  expect(qc.getQueryData(queryKeys.metrics)).toBeUndefined();
});
