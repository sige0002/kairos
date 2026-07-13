import { expect, test } from 'vitest';
import type { AlertEvent } from '../../api/types';
import { formatAlert, incidentCount, toAlertRows } from './alerts';

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
  // Incident identity is (topic, metric) — state/since do NOT split the row.
  expect(row.key).toBe('/hsrb/joint_states|hz');
  // Time is localized from `since` (non-empty, not the em-dash fallback).
  expect(row.time).not.toBe('—');
});

test('formatAlert: cleared alert → gray tone, no live value; missing op/since degrade', () => {
  const a: AlertEvent = { topic: '/cam/image', metric: 'gap', threshold: 100, state: 'cleared' };
  const row = formatAlert(a);
  expect(row.tone).toBe('gray');
  expect(row.state).toBe('cleared');
  expect(row.title).toBe('image gap 100'); // no op symbol when op is absent
  expect(row.detail).toBe(''); // a cleared row carries no live value
  expect(row.time).toBe('—'); // no since
});

test('formatAlert: absent state defaults to firing (a bare breach is active)', () => {
  const row = formatAlert({ topic: '/a', metric: 'bandwidth', threshold: 5 });
  expect(row.state).toBe('firing');
  expect(row.tone).toBe('red');
});

test('toAlertRows: collapses a re-sent firing incident to ONE row (I-6 dedup)', () => {
  // The monitor re-sends the same firing incident every tick; the buffer holds
  // many copies (newest-first). They must collapse to a single row.
  const alerts: AlertEvent[] = Array.from({ length: 8 }, (_, i) => ({
    topic: '/hsrb/hand_camera',
    metric: 'hz' as const,
    op: 'lt' as const,
    threshold: 30,
    value: 9 - i * 0.1, // newest first carries the latest value
    state: 'firing' as const,
    since: '2026-07-13T15:00:00Z',
  }));
  const rows = toAlertRows(alerts, 12);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.state).toBe('firing');
  expect(rows[0]!.detail).toBe('now 9'); // newest event's value wins
  expect(rows[0]!.refires).toBe(1); // one firing episode (stable `since`)
});

test('toAlertRows: newest event flips an incident firing→cleared in place', () => {
  const alerts: AlertEvent[] = [
    // newest first: a cleared event supersedes the earlier firing ones
    { topic: '/cam', metric: 'hz', threshold: 30, state: 'cleared', since: '2026-07-13T15:05:00Z' },
    { topic: '/cam', metric: 'hz', threshold: 30, value: 8, state: 'firing', since: '2026-07-13T15:00:00Z' },
  ];
  const rows = toAlertRows(alerts, 12);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.state).toBe('cleared');
  expect(rows[0]!.tone).toBe('gray');
  expect(rows[0]!.refires).toBe(1); // it fired once before clearing
});

test('toAlertRows: distinct firing `since` values count refires', () => {
  const alerts: AlertEvent[] = [
    { topic: '/cam', metric: 'hz', threshold: 30, value: 8, state: 'firing', since: 'B' },
    { topic: '/cam', metric: 'hz', threshold: 30, state: 'cleared', since: 'A-clear' },
    { topic: '/cam', metric: 'hz', threshold: 30, value: 8, state: 'firing', since: 'A' },
  ];
  const rows = toAlertRows(alerts, 12);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.state).toBe('firing');
  expect(rows[0]!.refires).toBe(2); // two firing episodes (since A and B)
});

test('toAlertRows: firing incidents sort above cleared ones', () => {
  const alerts: AlertEvent[] = [
    { topic: '/cleared', metric: 'hz', threshold: 30, state: 'cleared', since: 'c' },
    { topic: '/firing', metric: 'hz', threshold: 30, value: 8, state: 'firing', since: 'f' },
  ];
  const rows = toAlertRows(alerts, 12);
  expect(rows[0]!.state).toBe('firing');
  expect(rows[1]!.state).toBe('cleared');
});

test('toAlertRows: caps distinct incidents and preserves newest-first order', () => {
  const alerts: AlertEvent[] = Array.from({ length: 20 }, (_, i) => ({
    topic: `/t${i}`,
    metric: 'hz' as const,
    threshold: i,
    state: 'firing' as const,
    since: `T${i}`,
  }));
  const rows = toAlertRows(alerts, 12);
  expect(rows).toHaveLength(12);
  expect(rows[0]!.title).toBe('t0 Hz 0'); // first stays first (buffer newest-first)
  expect(rows[11]!.title).toBe('t11 Hz 11');
});

test('incidentCount: counts distinct (topic, metric), not raw buffer entries', () => {
  const alerts: AlertEvent[] = [
    { topic: '/cam', metric: 'hz', threshold: 30, state: 'firing' },
    { topic: '/cam', metric: 'hz', threshold: 30, state: 'firing' },
    { topic: '/cam', metric: 'gap', threshold: 100, state: 'firing' },
  ];
  expect(incidentCount(alerts)).toBe(2);
});
