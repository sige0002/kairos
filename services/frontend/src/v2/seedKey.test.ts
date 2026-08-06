import { beforeEach, expect, test } from 'vitest';
import { configSeedKey } from './seedKey';
import { useUiStore } from '../store/uiStore';

beforeEach(() => {
  useUiStore.setState({
    recordSelected: new Set<string>(),
    recordCustomized: false,
    recordSeededKey: null,
  });
});

test('the key ignores order but not membership', () => {
  expect(configSeedKey(['/b', '/a'])).toBe(configSeedKey(['/a', '/b']));
  expect(configSeedKey(['/a', '/b', '/c'])).not.toBe(configSeedKey(['/a', '/b']));
  expect(configSeedKey(['/a', '/x'])).not.toBe(configSeedKey(['/a', '/b']));
  expect(configSeedKey([])).toBe(configSeedKey([]));
});

test('the key does not mutate its input', () => {
  const names = ['/z', '/a'];
  configSeedKey(names);
  expect(names).toEqual(['/z', '/a']);
});

test('REORDERING default_topics keeps the operator Rec selection', () => {
  // Driven through the real uiStore, because the store is what decides to
  // discard the operator's work: it re-seeds whenever the key differs.
  const store = useUiStore.getState();
  store.seedRecordTopics(['/tf', '/joint_states'], configSeedKey(['/tf', '/joint_states']));

  // The operator customises: one configured topic dropped, one extra added.
  store.toggleRecordTopic('/tf');
  store.toggleRecordTopic('/hsrb/hand_camera');
  expect(useUiStore.getState().recordCustomized).toBe(true);

  // Someone reorders default_topics in Settings > Recording. Same set, new order.
  store.seedRecordTopics(
    ['/joint_states', '/tf'],
    configSeedKey(['/joint_states', '/tf']),
  );

  const after = useUiStore.getState();
  expect(after.recordSelected.has('/hsrb/hand_camera')).toBe(true); // addition survives
  expect(after.recordSelected.has('/tf')).toBe(false); // removal survives
  expect(after.recordCustomized).toBe(true);
});

test('a REAL config change still re-seeds and clears the customisation', () => {
  // The guard must not turn into a freeze: a different SET is a different robot,
  // and a stale selection must not reach the next Start.
  const store = useUiStore.getState();
  store.seedRecordTopics(['/tf', '/joint_states'], configSeedKey(['/tf', '/joint_states']));
  store.toggleRecordTopic('/hsrb/hand_camera');

  store.seedRecordTopics(['/other/odom'], configSeedKey(['/other/odom']));

  const after = useUiStore.getState();
  expect([...after.recordSelected]).toEqual(['/other/odom']);
  expect(after.recordCustomized).toBe(false);
});
