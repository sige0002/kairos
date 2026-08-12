// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
import { expect, test } from 'vitest';
import { buildCandidates, isGlob, matchesTopic } from './topics';

test('matchesTopic: exact and glob (fnmatch-style)', () => {
  expect(matchesTopic('/joint_states', '/joint_states')).toBe(true);
  expect(matchesTopic('/joint_states', '/other')).toBe(false);
  expect(isGlob('/camera/*/compressed')).toBe(true);
  expect(matchesTopic('/camera/*/compressed', '/camera/head/compressed')).toBe(true);
  // fnmatch '*' spans '/', matching Python's behaviour.
  expect(matchesTopic('**/compressed', '/a/b/image/compressed')).toBe(true);
  expect(matchesTopic('/camera/*/compressed', '/camera/head/rgb/raw')).toBe(false);
});

test('buildCandidates: flags configured + live, keeps offline configured topics', () => {
  const { candidates, unmatchedPatterns } = buildCandidates(
    ['/hsrb/joint_states', '/camera/*/compressed', '/offline_topic'],
    [
      { name: '/hsrb/joint_states', type: 'sensor_msgs/msg/JointState' },
      { name: '/camera/head/compressed', type: 'sensor_msgs/msg/CompressedImage' },
      { name: '/unconfigured', type: 'std_msgs/msg/String' },
    ],
  );
  const by = Object.fromEntries(candidates.map((c) => [c.name, c]));

  // concrete configured + live
  expect(by['/hsrb/joint_states']).toMatchObject({ configured: true, live: true });
  // glob-configured live topic is flagged configured
  expect(by['/camera/head/compressed']).toMatchObject({ configured: true, live: true });
  // live but not configured
  expect(by['/unconfigured']).toMatchObject({ configured: false, live: true });
  // concrete configured but offline still listed (pre-checkable)
  expect(by['/offline_topic']).toMatchObject({ configured: true, live: false });
  // glob patterns are not unmatched here (one live topic matched)
  expect(unmatchedPatterns).toEqual([]);
});

test('buildCandidates: surfaces configured glob patterns that match nothing live', () => {
  const { unmatchedPatterns } = buildCandidates(
    ['/camera/*/compressed'],
    [{ name: '/joint_states', type: 'sensor_msgs/msg/JointState' }],
  );
  expect(unmatchedPatterns).toEqual(['/camera/*/compressed']);
});
