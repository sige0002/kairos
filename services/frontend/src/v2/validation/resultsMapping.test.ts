// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
import { expect, test } from 'vitest';
import {
  buildChecklist,
  hasEpisodeBreakdown,
  mapEpisodeRows,
  tileCounts,
  type EpisodeOutcome,
} from './resultsMapping';

const CAP_1 = '01920000-0000-7000-8000-000000000001';
const CAP_2 = '01920000-0000-7000-8000-000000000002';
const CAP_3 = '01920000-0000-7000-8000-000000000003';
const CAP_4 = '01920000-0000-7000-8000-000000000004';
const CAP_5 = '01920000-0000-7000-8000-000000000005';

test('a single-capture submission never has an episode breakdown', () => {
  const outcomes: EpisodeOutcome[] = [{ captureId: CAP_1, summary: { result: 'pass' } }];
  expect(hasEpisodeBreakdown(outcomes)).toBe(false);
});

test('a batch of more than one capture has an episode breakdown', () => {
  const outcomes: EpisodeOutcome[] = [
    { captureId: CAP_1, summary: { result: 'pass' } },
    { captureId: CAP_2, summary: { result: 'fail' } },
  ];
  expect(hasEpisodeBreakdown(outcomes)).toBe(true);
});

test('maps pass/fail/unknown/orchestration-failure summaries onto OK/FAIL/WARNING rows', () => {
  const outcomes: EpisodeOutcome[] = [
    { captureId: CAP_1, summary: { result: 'pass' } },
    { captureId: CAP_2, summary: { result: 'fail' } },
    { captureId: CAP_3, summary: { result: 'something-else' } },
    { captureId: CAP_4, orchestrationFailed: true },
    { captureId: CAP_5 }, // still running / no summary yet
  ];
  const rows = mapEpisodeRows(outcomes);
  expect(rows.map((r) => r.tone)).toEqual(['OK', 'FAIL', 'WARNING', 'WARNING', 'WARNING']);
  expect(rows.map((r) => r.captureId)).toEqual([CAP_1, CAP_2, CAP_3, CAP_4, CAP_5]);
});

test('a row keeps the capture display name, and leaves it unset when there is none', () => {
  const rows = mapEpisodeRows([
    { captureId: CAP_1, label: 'run_20260713_120000', summary: { result: 'pass' } },
    { captureId: CAP_2, summary: { result: 'pass' } },
  ]);
  expect(rows.map((r) => r.label)).toEqual(['run_20260713_120000', undefined]);
});

test('pulls a 0-100 coverage number from summary.coverage or summary.metrics.coverage', () => {
  const rows = mapEpisodeRows([
    { captureId: CAP_1, summary: { result: 'pass', coverage: 95.2 } },
    { captureId: CAP_2, summary: { result: 'pass', metrics: { coverage: 72.1 } } },
    { captureId: CAP_3, summary: { result: 'pass' } },
  ]);
  expect(rows.map((r) => r.coverage)).toEqual([95.2, 72.1, null]);
});

test('tileCounts buckets rows into OK/WARNING/FAIL with rounded percentages', () => {
  const rows = mapEpisodeRows([
    { captureId: CAP_1, summary: { result: 'pass' } },
    { captureId: CAP_2, summary: { result: 'pass' } },
    { captureId: CAP_3, summary: { result: 'fail' } },
  ]);
  const counts = tileCounts(rows);
  expect(counts).toMatchObject({ ok: 2, warning: 0, fail: 1, total: 3 });
  expect(counts.okPct).toBeCloseTo(66.7, 1);
  expect(counts.failPct).toBeCloseTo(33.3, 1);
});

test('tileCounts on an empty list reports zero percentages, not NaN', () => {
  const counts = tileCounts([]);
  expect(counts).toEqual({ ok: 0, warning: 0, fail: 0, total: 0, okPct: 0, warningPct: 0, failPct: 0 });
});

test('buildChecklist marks each required topic found unless it is in summary.missing', () => {
  const required = [
    { name: '/hsrb/joint_states', type: 'sensor_msgs/msg/JointState' },
    { name: '/hsrb/odom', type: 'nav_msgs/msg/Odometry' },
    { name: '/hsrb/hand_camera/image_raw/compressed', type: null },
  ];
  const summary = {
    result: 'fail' as const,
    missing: [{ name: '/hsrb/odom', type: 'nav_msgs/msg/Odometry' }],
    extra: [{ name: '/camera/head' }, { name: '/camera/left' }],
  };
  const checklist = buildChecklist(summary, required);
  expect(checklist.pass).toBe(false);
  expect(checklist.total).toBe(3);
  expect(checklist.found).toBe(2);
  expect(checklist.extraCount).toBe(2);
  expect(checklist.rows.map((r) => [r.name, r.found])).toEqual([
    ['/hsrb/joint_states', true],
    ['/hsrb/odom', false],
    ['/hsrb/hand_camera/image_raw/compressed', true],
  ]);
});

test('buildChecklist falls back to the summary.missing rows when the template is unresolved', () => {
  const summary = {
    result: 'fail' as const,
    missing: [{ name: '/hsrb/joint_states', type: 'sensor_msgs/msg/JointState' }],
  };
  const checklist = buildChecklist(summary, []);
  expect(checklist.total).toBe(1);
  expect(checklist.found).toBe(0);
  expect(checklist.rows[0]).toMatchObject({ name: '/hsrb/joint_states', found: false });
});

test('buildChecklist on a clean pass has every required topic found and no extras counted', () => {
  const required = [{ name: '/hsrb/joint_states', type: 'sensor_msgs/msg/JointState' }];
  const checklist = buildChecklist({ result: 'pass', missing: [] }, required);
  expect(checklist.pass).toBe(true);
  expect(checklist.found).toBe(1);
  expect(checklist.rows[0]!.found).toBe(true);
});
