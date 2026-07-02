import { beforeEach, expect, test } from 'vitest';
import { useUiStore } from './uiStore';

beforeEach(() => {
  // Reset the shared singleton so seed state doesn't leak between tests.
  useUiStore.setState({
    recordSelected: new Set(),
    recordCustomized: false,
    recordSeededKey: null,
    scopeOpen: false,
    scopeWindowId: '1m',
    scopePanels: [],
    scopePanelSeq: 0,
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

// FE-H2: clicking the same Monitor topic twice must not create two Health
// panels — it should just (re)open the band on the existing one.
test('addHealthPanel dedups the same topic and opens the band', () => {
  useUiStore.getState().addHealthPanel('/hsrb/odom');
  expect(useUiStore.getState().scopePanels).toHaveLength(1);
  expect(useUiStore.getState().scopeOpen).toBe(true);

  useUiStore.setState({ scopeOpen: false }); // simulate the operator collapsing it
  useUiStore.getState().addHealthPanel('/hsrb/odom');
  expect(useUiStore.getState().scopePanels).toHaveLength(1); // still just one panel
  expect(useUiStore.getState().scopeOpen).toBe(true); // re-opened

  // A different topic is a genuinely new panel.
  useUiStore.getState().addHealthPanel('/hsrb/joint_states');
  expect(useUiStore.getState().scopePanels).toHaveLength(2);
});

test('addHealthPanel with no topic always adds a new (empty-topics) panel', () => {
  useUiStore.getState().addHealthPanel();
  useUiStore.getState().addHealthPanel();
  expect(useUiStore.getState().scopePanels).toHaveLength(2);
  expect(useUiStore.getState().scopePanels.every((p) => p.kind === 'health' && p.topics.length === 0)).toBe(
    true,
  );
});

test('removeScopePanel drops only the targeted panel', () => {
  useUiStore.getState().addHealthPanel('/a');
  useUiStore.getState().addHealthPanel('/b');
  const [first, second] = useUiStore.getState().scopePanels;
  useUiStore.getState().removeScopePanel(first!.id);
  expect(useUiStore.getState().scopePanels).toEqual([second]);
});

test('updateScopePanel changes a health panel metric in place', () => {
  useUiStore.getState().addHealthPanel('/a');
  const panel = useUiStore.getState().scopePanels[0]!;
  expect(panel.kind).toBe('health');

  useUiStore.getState().updateScopePanel(panel.id, { metric: 'shortfall' });

  const updated = useUiStore.getState().scopePanels[0]!;
  expect(updated.id).toBe(panel.id);
  expect(updated.kind).toBe('health');
  expect(updated).toMatchObject({ metric: 'shortfall', topics: ['/a'] });
});
