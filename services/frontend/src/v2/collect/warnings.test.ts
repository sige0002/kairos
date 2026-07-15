// Pure-function tests for the Collect Active-warnings / Topic-rates mapping.

import { expect, test } from 'vitest';
import type { AlertEvent, MetricsSnapshot, RecordArming } from '../../api/types';
import { firingAlertRows, topicRates } from './warnings';

function alert(over: Partial<AlertEvent>): AlertEvent {
  return {
    topic: '/hsrb/joint_states',
    metric: 'hz',
    op: 'lt',
    threshold: 45,
    value: 38.2,
    state: 'firing',
    since: '2026-07-15T00:00:00Z',
    ...over,
  };
}

const ARMING: RecordArming = {
  active: false,
  matched_topics: ['/hsrb/joint_states', '/camera/image'],
  missing_topics: ['/hsrb/wrist_wrench'],
  resume_at: null,
  disarm_at: null,
};

test('cleared alerts are dropped; firing ones survive', () => {
  const rows = firingAlertRows(
    [alert({}), alert({ topic: '/camera/image', state: 'cleared' })],
    null,
    [],
  );
  expect(rows.map((r) => r.topic)).toEqual(['/hsrb/joint_states']);
});

test('with an arming snapshot, only its target topics (matched OR missing) pass', () => {
  const rows = firingAlertRows(
    [
      alert({ topic: '/hsrb/joint_states' }), // matched target
      alert({ topic: '/hsrb/wrist_wrench', metric: 'gap' }), // missing target
      alert({ topic: '/tf' }), // not a target
    ],
    ARMING,
    ['/tf'], // patterns must NOT apply when arming is present
  );
  expect(rows.map((r) => r.topic).sort()).toEqual([
    '/hsrb/joint_states',
    '/hsrb/wrist_wrench',
  ]);
});

test('without arming, default_topics patterns filter (glob supported)', () => {
  const rows = firingAlertRows(
    [alert({ topic: '/hsrb/joint_states' }), alert({ topic: '/tf' })],
    null,
    ['/hsrb/*'],
  );
  expect(rows.map((r) => r.topic)).toEqual(['/hsrb/joint_states']);
});

test('with neither arming nor default_topics, every firing alert passes', () => {
  const rows = firingAlertRows([alert({ topic: '/tf' })], null, []);
  expect(rows.map((r) => r.topic)).toEqual(['/tf']);
});

test('the newest event per incident wins: a breach that cleared shows nothing', () => {
  // Buffer is newest-first (useEventStream prepends).
  const rows = firingAlertRows(
    [alert({ state: 'cleared' }), alert({ state: 'firing' })],
    null,
    [],
  );
  expect(rows).toEqual([]);
});

function metrics(topics: MetricsSnapshot['topics']): MetricsSnapshot {
  return { topics } as MetricsSnapshot;
}

test('topicRates counts ok vs judged, excluding unknown', () => {
  const rates = topicRates(
    metrics([
      { name: '/a', status: 'ok' },
      { name: '/b', status: 'warning' },
      { name: '/c', status: 'unknown' },
      { name: '/d' }, // no status at all
    ]),
  );
  expect(rates).toEqual({ ok: 1, judged: 2 });
});

test('topicRates is null with no snapshot or no judged topic', () => {
  expect(topicRates(undefined)).toBeNull();
  expect(topicRates(metrics([{ name: '/a', status: 'unknown' }]))).toBeNull();
});
