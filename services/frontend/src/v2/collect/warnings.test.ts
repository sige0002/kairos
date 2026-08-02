// Pure-function tests for the Collect Active-warnings / Topic-rates mapping.

import { expect, test } from 'vitest';
import type { AlertEvent, MetricsSnapshot, RecordArming } from '../../api/types';
import {
  armingWarning,
  configMismatchHint,
  firingAlertRows,
  topicRates,
} from './warnings';

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

test('unsubscribed targets are targets too: their alerts pass the arming filter', () => {
  const rows = firingAlertRows(
    [alert({ topic: '/camera/head' }), alert({ topic: '/tf' })],
    { ...ARMING, unsubscribed_topics: ['/camera/head'] },
    [],
  );
  expect(rows.map((r) => r.topic)).toEqual(['/camera/head']);
});

test('armingWarning: no publisher -> "not publishing"', () => {
  expect(armingWarning(ARMING)).toMatchObject({
    topics: ['/hsrb/wrist_wrench'],
    title: '1 target topic not publishing',
  });
});

test('armingWarning: published-but-unsubscribed is NEVER called "not publishing"', () => {
  // The exact reported bug: the topic is live (visible in Monitor) and the card
  // claimed it was not publishing.
  const warning = armingWarning({
    ...ARMING,
    missing_topics: [],
    unsubscribed_topics: ['/camera/head'],
  });
  expect(warning?.title).toBe('1 target topic not subscribed yet');
  expect(warning?.title).not.toContain('not publishing');
  expect(warning?.detail).toContain('These are publishing');
});

test('armingWarning: mixed causes claim neither, and count both', () => {
  const warning = armingWarning({
    ...ARMING,
    missing_topics: ['/lidar'],
    unsubscribed_topics: ['/camera/head'],
  });
  expect(warning?.title).toBe('2 target topics not being captured');
  expect(warning?.topics).toEqual(['/lidar', '/camera/head']);
});

test('armingWarning is null when every target matched, or with no snapshot', () => {
  expect(armingWarning({ ...ARMING, missing_topics: [] })).toBeNull();
  expect(armingWarning(null)).toBeNull();
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

// M-NEW: "the robot is down" and "the wrong robot config is selected" rendered
// identically — same counters, same "not publishing" wording — while a hundred
// foreign topics streamed at full rate. The distinguishing fact is that the
// configured set is silent while the graph is busy.
test('configMismatchHint fires when the graph dwarfs the silent configured set', () => {
  expect(configMismatchHint(7, 131)).toEqual({ configuredSilent: 7, discovered: 131 });
});

test('configMismatchHint stays silent for a genuinely quiet graph', () => {
  // Nothing publishing at all is the case the existing wording already gets
  // right; adding a mismatch guess there would be noise.
  expect(configMismatchHint(7, 0)).toBeNull();
});

test('configMismatchHint stays silent when nothing configured is missing', () => {
  expect(configMismatchHint(0, 131)).toBeNull();
});

test('configMismatchHint ignores a robot publishing a few extras', () => {
  // Ordinary: some diagnostics topics alongside the configured set. Only an
  // order-of-magnitude gap is a question worth raising.
  expect(configMismatchHint(7, 12)).toBeNull();
  expect(configMismatchHint(7, 21)).not.toBeNull();
});
