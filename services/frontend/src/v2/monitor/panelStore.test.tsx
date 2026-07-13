import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import { MAX_SERIES } from './chartSeries';
import {
  MAX_PANELS,
  __resetPanelStore,
  addPanel,
  addPanelTo,
  nextMetric,
  removePanel,
  removePanelFrom,
  resolvePanelTopics,
  setMetricIn,
  setPanelMetric,
  setPanelTopics,
  setTopicsIn,
  usePanels,
  type ChartPanel,
} from './panelStore';

beforeEach(() => __resetPanelStore());

// --- pure operations -------------------------------------------------------

test('nextMetric: first unused registry metric, cycling Hz→Bandwidth→gap→rate', () => {
  expect(nextMetric([{ id: 0, metric: 'hz', topics: null }])).toBe('bw');
  expect(
    nextMetric([
      { id: 0, metric: 'hz', topics: null },
      { id: 1, metric: 'bw', topics: [] },
    ]),
  ).toBe('gap');
  // Everything already on screen → falls back to the first metric.
  const all: ChartPanel[] = [
    { id: 0, metric: 'hz', topics: null },
    { id: 1, metric: 'bw', topics: [] },
    { id: 2, metric: 'gap', topics: [] },
    { id: 3, metric: 'rate', topics: [] },
  ];
  expect(nextMetric(all)).toBe('hz');
});

test('addPanelTo: appends with an incremented id, the next metric, and the seed topic', () => {
  const one: ChartPanel[] = [{ id: 0, metric: 'hz', topics: null }];
  const two = addPanelTo(one, '/a');
  expect(two).toHaveLength(2);
  expect(two[1]).toEqual({ id: 1, metric: 'bw', topics: ['/a'] });
  // No seed topic → an explicit empty set (never null for a non-primary panel).
  expect(addPanelTo(one)[1]!.topics).toEqual([]);
});

test('addPanelTo: is a no-op returning the SAME array at the panel cap', () => {
  let panels: ChartPanel[] = [{ id: 0, metric: 'hz', topics: null }];
  for (let i = 1; i < MAX_PANELS; i++) panels = addPanelTo(panels, `/t${i}`);
  expect(panels).toHaveLength(MAX_PANELS);
  expect(addPanelTo(panels, '/x')).toBe(panels); // reference-equal = guarded no-op
});

test('addPanelTo: ids stay unique after a removal (max+1, not length)', () => {
  let panels = addPanelTo(addPanelTo([{ id: 0, metric: 'hz', topics: null }]), '/b'); // ids 0,1,2
  panels = removePanelFrom(panels, 1); // drop the middle → ids 0,2
  const added = addPanelTo(panels, '/c');
  expect(added.map((p) => p.id)).toEqual([0, 2, 3]); // max(0,2)+1 = 3, no collision with 2
});

test('removePanelFrom: removes by id but never drops the last panel', () => {
  const two: ChartPanel[] = [
    { id: 0, metric: 'hz', topics: null },
    { id: 1, metric: 'bw', topics: [] },
  ];
  expect(removePanelFrom(two, 1).map((p) => p.id)).toEqual([0]);
  const one: ChartPanel[] = [{ id: 0, metric: 'hz', topics: null }];
  expect(removePanelFrom(one, 0)).toBe(one); // last panel is never removed (no-op)
  expect(removePanelFrom(two, 99)).toBe(two); // absent id → no-op
});

test('setMetricIn / setTopicsIn: change only the targeted panel', () => {
  const panels: ChartPanel[] = [
    { id: 0, metric: 'hz', topics: null },
    { id: 1, metric: 'bw', topics: ['/a'] },
  ];
  expect(setMetricIn(panels, 1, 'gap')[1]!.metric).toBe('gap');
  expect(setMetricIn(panels, 1, 'gap')[0]!.metric).toBe('hz');
  expect(setTopicsIn(panels, 0, ['/x'])[0]!.topics).toEqual(['/x']);
  expect(setTopicsIn(panels, 0, ['/x'])[1]!.topics).toEqual(['/a']);
});

test('resolvePanelTopics: primary null auto-tracks the first available topic', () => {
  expect(resolvePanelTopics(null, true, ['/a', '/b'])).toEqual(['/a']);
  // A non-primary panel never auto-tracks — null resolves to an empty set.
  expect(resolvePanelTopics(null, false, ['/a', '/b'])).toEqual([]);
  // No topics available at all → nothing charted even for the primary.
  expect(resolvePanelTopics(null, true, [])).toEqual([]);
});

test('resolvePanelTopics: an explicit set is filtered to present topics and capped', () => {
  // A topic that has since disappeared is dropped.
  expect(resolvePanelTopics(['/a', '/gone', '/b'], false, ['/a', '/b'])).toEqual(['/a', '/b']);
  // Over-long explicit set is capped at the overlay limit.
  const many = Array.from({ length: MAX_SERIES + 3 }, (_, i) => `/t${i}`);
  expect(resolvePanelTopics(many, false, many)).toHaveLength(MAX_SERIES);
});

// --- module store wiring ---------------------------------------------------

test('store: starts with a single primary panel (hz, untouched)', () => {
  const { result } = renderHook(() => usePanels());
  expect(result.current).toEqual([{ id: 0, metric: 'hz', topics: null }]);
});

test('store: add / setMetric / setTopics / remove flow through usePanels; reset restores default', () => {
  const { result } = renderHook(() => usePanels());

  act(() => addPanel('/a'));
  expect(result.current).toHaveLength(2);
  expect(result.current[1]).toEqual({ id: 1, metric: 'bw', topics: ['/a'] });

  act(() => setPanelMetric(1, 'gap'));
  expect(result.current[1]!.metric).toBe('gap');

  act(() => setPanelTopics(1, ['/a', '/b']));
  expect(result.current[1]!.topics).toEqual(['/a', '/b']);

  act(() => removePanel(1));
  expect(result.current).toHaveLength(1);

  act(() => addPanel());
  act(() => __resetPanelStore());
  expect(result.current).toEqual([{ id: 0, metric: 'hz', topics: null }]);
});
