// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
import { beforeEach, expect, test } from 'vitest';
import { useUiStore } from './uiStore';

beforeEach(() => {
  // Reset the shared singleton so seed state doesn't leak between tests.
  useUiStore.setState({
    recordSelected: new Set(),
    recordCustomized: false,
    recordSeededKey: null,
    recordOperator: '',
    operatorHydrated: false,
    batchRestoreIssue: null,
  });
});

// FE-H1: the record-topic selection seeds once per config key, survives further
// seed calls with the same key, and re-seeds (resetting a customized set) when
// the key changes — the robot-switch case that used to leave the previous
// robot's selection in place.
test('seedRecordTopics seeds once per key and ignores repeat seeds', () => {
  const key = JSON.stringify(['/a']);
  useUiStore.getState().seedRecordTopics(['/a'], key);
  expect([...useUiStore.getState().recordSelected]).toEqual(['/a']);
  expect(useUiStore.getState().recordSeededKey).toBe(key);

  // A later seed with the SAME key (e.g. discovery refresh) is a no-op — it must
  // not clobber the operator's selection.
  useUiStore.getState().toggleRecordTopic('/b'); // customize
  useUiStore.getState().seedRecordTopics(['/a'], key);
  expect(new Set(useUiStore.getState().recordSelected)).toEqual(new Set(['/a', '/b']));
  expect(useUiStore.getState().recordCustomized).toBe(true);
});

test('a new config key re-seeds and clears a stale customized selection', () => {
  const key1 = JSON.stringify(['/hsrb/a']);
  useUiStore.getState().seedRecordTopics(['/hsrb/a'], key1);
  useUiStore.getState().toggleRecordTopic('/hsrb/b'); // operator customizes robot 1
  expect(useUiStore.getState().recordCustomized).toBe(true);

  // Robot switch: different default_topics -> different key -> re-seed.
  const key2 = JSON.stringify(['/other/x']);
  useUiStore.getState().seedRecordTopics(['/other/x'], key2);

  expect([...useUiStore.getState().recordSelected]).toEqual(['/other/x']);
  expect(useUiStore.getState().recordCustomized).toBe(false);
  expect(useUiStore.getState().recordSeededKey).toBe(key2);
});

test('changing or hydrating an operator clears an old ambiguous restore warning', () => {
  useUiStore.setState({ batchRestoreIssue: 'ambiguous' });
  useUiStore.getState().setRecordOperator('next operator');
  expect(useUiStore.getState().batchRestoreIssue).toBeNull();

  useUiStore.setState({ batchRestoreIssue: 'ambiguous', operatorHydrated: false });
  useUiStore.getState().hydrateRecordOperator('stored operator');
  expect(useUiStore.getState().batchRestoreIssue).toBeNull();
  expect(useUiStore.getState().operatorHydrated).toBe(true);
});

// FE-H2: clicking the same Monitor topic twice must not create two Health
// panels — it should just (re)open the band on the existing one.
