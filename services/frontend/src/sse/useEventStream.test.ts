import { QueryClient } from '@tanstack/react-query';
import { expect, test } from 'vitest';
import { queryKeys } from '../api/queryKeys';
import type { AlertEvent, MetricsSnapshot, RecordStatusEvent } from '../api/types';
import { dispatchSseEvent } from './useEventStream';

test('metrics event writes the metrics query cache', () => {
  const qc = new QueryClient();
  const snapshot: MetricsSnapshot = {
    topics: [{ topic: '/camera/head/image_raw', hz: 29.7, expected_hz: 30 }],
  };
  dispatchSseEvent(qc, 'metrics', JSON.stringify(snapshot));
  expect(qc.getQueryData<MetricsSnapshot>(queryKeys.metrics)).toEqual(snapshot);
});

test('alert events accumulate newest-first in the alerts cache', () => {
  const qc = new QueryClient();
  const a1: AlertEvent = {
    topic: '/a',
    metric: 'hz',
    level: 'warn',
    value: 1,
    threshold: 5,
  };
  const a2: AlertEvent = {
    topic: '/b',
    metric: 'loss',
    level: 'critical',
    value: 9,
    threshold: 1,
  };
  dispatchSseEvent(qc, 'alert', JSON.stringify(a1));
  dispatchSseEvent(qc, 'alert', JSON.stringify(a2));
  const alerts = qc.getQueryData<AlertEvent[]>(queryKeys.alerts);
  expect(alerts?.[0]).toEqual(a2);
  expect(alerts?.[1]).toEqual(a1);
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
