import { expect, test } from 'vitest';
import type { AlertEvent } from '../../api/types';
import { formatAlert, toAlertRows } from './alerts';

test('formatAlert: firing breach → red tone, short topic, op symbol, value detail', () => {
  const a: AlertEvent = {
    topic: '/hsrb/joint_states',
    metric: 'hz',
    op: 'lt',
    threshold: 45,
    value: 42.1,
    state: 'firing',
    since: '2026-07-13T15:29:21Z',
  };
  const row = formatAlert(a);
  expect(row.tone).toBe('red');
  expect(row.state).toBe('firing');
  expect(row.title).toBe('joint_states Hz < 45');
  expect(row.detail).toBe('now 42.1');
  // Time is localized from `since` (non-empty, not the em-dash fallback).
  expect(row.time).not.toBe('—');
});

test('formatAlert: cleared alert → gray tone; missing op/value/since degrade gracefully', () => {
  const a: AlertEvent = { topic: '/cam/image', metric: 'gap', threshold: 100, state: 'cleared' };
  const row = formatAlert(a);
  expect(row.tone).toBe('gray');
  expect(row.state).toBe('cleared');
  expect(row.title).toBe('image gap 100'); // no op symbol when op is absent
  expect(row.detail).toBe(''); // no value
  expect(row.time).toBe('—'); // no since
});

test('formatAlert: absent state defaults to firing (a bare breach is active)', () => {
  const row = formatAlert({ topic: '/a', metric: 'bandwidth', threshold: 5 });
  expect(row.state).toBe('firing');
  expect(row.tone).toBe('red');
});

test('toAlertRows: caps the (newest-first) buffer and preserves order', () => {
  const alerts: AlertEvent[] = Array.from({ length: 20 }, (_, i) => ({
    topic: `/t${i}`,
    metric: 'hz' as const,
    threshold: i,
    state: 'firing' as const,
  }));
  const rows = toAlertRows(alerts, 12);
  expect(rows).toHaveLength(12);
  expect(rows[0]!.title).toBe('t0 Hz 0'); // first stays first (buffer already newest-first)
  expect(rows[11]!.title).toBe('t11 Hz 11');
});
