// Pure-function tests for the Collect Active-warnings / Topic-rates mapping.

import { expect, test } from 'vitest';
import type { AlertEvent, MetricsSnapshot, RecordArming } from '../../api/types';
import type { MonitorRow } from '../../features/monitor/useMonitorRows';
import {
  armingWarning,
  configMismatchHint,
  firingAlertRows,
  topicLiveness,
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

// A1-REPOINT: frame deltas cannot answer this. qa-ui hooked RTCPeerConnection
// and found the streamer keeps delivering a real 15fps after the source dies —
// it re-encodes the frozen last frame — so the only honest signal is the
// monitor's own view of the topic.
const row = (over: Partial<MonitorRow> & { name: string }): MonitorRow => ({
  configured: true,
  live: true,
  measured: true,
  ...over,
});

test('topicLiveness reports a measured, inactive topic as silent', () => {
  expect(topicLiveness([row({ name: '/cam/head', status: 'inactive' })], '/cam/head')).toBe(
    'silent',
  );
});

test('topicLiveness reports a topic discovery no longer lists as silent', () => {
  // The add-camera picker already surfaces this as "No image topics found".
  expect(topicLiveness([row({ name: '/cam/other' })], '/cam/head')).toBe('silent');
});

test('topicLiveness reports a publishing topic as live', () => {
  expect(topicLiveness([row({ name: '/cam/head', status: 'ok' })], '/cam/head')).toBe('live');
});

test('topicLiveness says unknown when there is no monitor data at all', () => {
  // Nothing has been established, and that must not render as either answer.
  expect(topicLiveness([], '/cam/head')).toBe('unknown');
});

// UNMONITORED TILE: being on the graph is not evidence of publishing. A topic
// stays in discovery for as long as anything is attached to it, and the
// streamer's own preview subscription keeps it there after the publisher dies —
// which is how an unmeasured camera earned a confident frame rate.
test('topicLiveness will not call a topic live just because discovery lists it', () => {
  const rows = [
    row({ name: '/cam/head', status: 'ok' }),
    row({ name: '/cam/depth', measured: false }),
  ];
  expect(topicLiveness(rows, '/cam/depth')).toBe('unmonitored');
  // The measured neighbour is unaffected — this is a coverage gap, not doubt
  // about the monitor.
  expect(topicLiveness(rows, '/cam/head')).toBe('live');
});

test('topicLiveness keeps an unmeasured topic apart from a blind monitor', () => {
  // Nothing measured anywhere: the monitor is not answering, so we have not
  // established that this topic is unwatched — only that we cannot see.
  const discoveryOnly = [
    row({ name: '/cam/head', measured: false }),
    row({ name: '/cam/depth', measured: false }),
  ];
  expect(topicLiveness(discoveryOnly, '/cam/depth')).toBe('unknown');
});

// DEAD SOURCE, DEFINITELY: discovery counts publishers, and zero publishers
// means no one can be producing frames — the topic is on the graph only
// because something subscribes to it (our own preview subscription is enough).
// That is a fact about the topic, not about monitoring coverage, so it must
// read as silent even for a camera outside the monitored set.
test('topicLiveness calls a publisher-less unmeasured topic silent, not unmonitored', () => {
  const rows = [
    row({ name: '/cam/head', status: 'ok' }),
    row({ name: '/cam/depth', measured: false, publisher_count: 0 }),
  ];
  expect(topicLiveness(rows, '/cam/depth')).toBe('silent');
});

test('topicLiveness trusts a zero publisher count even when the monitor is blind', () => {
  // The count comes from the /topics discovery poll, not the metrics snapshot,
  // so it stands on its own — no measured row anywhere is required.
  const discoveryOnly = [row({ name: '/cam/depth', measured: false, publisher_count: 0 })];
  expect(topicLiveness(discoveryOnly, '/cam/depth')).toBe('silent');
});

test('topicLiveness keeps unmonitored for an unmeasured topic that HAS a publisher', () => {
  // A live publisher outside the monitored set is exactly the coverage gap the
  // unmonitored answer exists for — zero-publisher certainty must not leak
  // onto it.
  const rows = [
    row({ name: '/cam/head', status: 'ok' }),
    row({ name: '/cam/depth', measured: false, publisher_count: 1 }),
  ];
  expect(topicLiveness(rows, '/cam/depth')).toBe('unmonitored');
});

test('topicLiveness lets measured traffic outrank a momentary zero publisher count', () => {
  // The count is one discovery sample; observed frames are evidence. A restart
  // flap must not flip a measured-live tile — real silence reaches us as
  // status: inactive within the monitor's own window.
  expect(
    topicLiveness([row({ name: '/cam/head', status: 'ok', publisher_count: 0 })], '/cam/head'),
  ).toBe('live');
});
