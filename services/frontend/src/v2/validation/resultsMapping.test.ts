import { expect, test } from 'vitest';
import {
  buildChecklist,
  hasEpisodeBreakdown,
  mapEpisodeRows,
  tileCounts,
  type EpisodeOutcome,
} from './resultsMapping';

test('a single-run submission never has an episode breakdown', () => {
  const outcomes: EpisodeOutcome[] = [{ runId: 'run_001', summary: { result: 'pass' } }];
  expect(hasEpisodeBreakdown(outcomes)).toBe(false);
});

test('a batch of more than one run has an episode breakdown', () => {
  const outcomes: EpisodeOutcome[] = [
    { runId: 'run_001', summary: { result: 'pass' } },
    { runId: 'run_002', summary: { result: 'fail' } },
  ];
  expect(hasEpisodeBreakdown(outcomes)).toBe(true);
});

test('maps pass/fail/unknown/orchestration-failure summaries onto OK/FAIL/WARNING rows', () => {
  const outcomes: EpisodeOutcome[] = [
    { runId: 'run_001', summary: { result: 'pass' } },
    { runId: 'run_002', summary: { result: 'fail' } },
    { runId: 'run_003', summary: { result: 'something-else' } },
    { runId: 'run_004', orchestrationFailed: true },
    { runId: 'run_005' }, // still running / no summary yet
  ];
  const rows = mapEpisodeRows(outcomes);
  expect(rows.map((r) => r.tone)).toEqual(['OK', 'FAIL', 'WARNING', 'WARNING', 'WARNING']);
});

test('pulls a 0-100 coverage number from summary.coverage or summary.metrics.coverage', () => {
  const rows = mapEpisodeRows([
    { runId: 'a', summary: { result: 'pass', coverage: 95.2 } },
    { runId: 'b', summary: { result: 'pass', metrics: { coverage: 72.1 } } },
    { runId: 'c', summary: { result: 'pass' } },
  ]);
  expect(rows.map((r) => r.coverage)).toEqual([95.2, 72.1, null]);
});

test('tileCounts buckets rows into OK/WARNING/FAIL with rounded percentages', () => {
  const rows = mapEpisodeRows([
    { runId: '1', summary: { result: 'pass' } },
    { runId: '2', summary: { result: 'pass' } },
    { runId: '3', summary: { result: 'fail' } },
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
