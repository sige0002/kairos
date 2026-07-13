import { expect, test } from 'vitest';
import type { MetricSample } from '../../features/graph/useMetricHistory';
import {
  MAX_SERIES,
  MONITOR_METRICS,
  alignHzSeries,
  alignMetricSeries,
  buildLabelMap,
  hasAnyValue,
  metricDef,
  paletteColor,
  toggleTopic,
  windowMs,
} from './chartSeries';

// Minimal sample factory — only `t` and `hz` matter for the Hz overlay.
const s = (t: number, hz: number | null): MetricSample =>
  ({ t, hz }) as MetricSample;

// Fuller factory for the metric-registry tests (bw/gap/rate).
const sample = (t: number, fields: Partial<MetricSample>): MetricSample =>
  ({ t, hz: null, bw: null, gap: null, rate: null, ...fields }) as MetricSample;

test('alignHzSeries: shared ticks align 1:1 with no nulls, x is seconds ascending', () => {
  const history = new Map<string, MetricSample[]>([
    ['/a', [s(1000, 10), s(2000, 12)]],
    ['/b', [s(1000, 5), s(2000, 6)]],
  ]);
  const { xs, cols } = alignHzSeries(['/a', '/b'], history);
  expect(xs).toEqual([1, 2]); // ms -> s, sorted
  expect(cols).toEqual([
    [10, 12],
    [5, 6],
  ]);
});

test('alignHzSeries: a topic missing a tick is null-filled at that slot', () => {
  const history = new Map<string, MetricSample[]>([
    ['/a', [s(1000, 10), s(2000, 12), s(3000, 14)]],
    ['/b', [s(1000, 5), s(3000, 7)]], // no sample at t=2000
  ]);
  const { xs, cols } = alignHzSeries(['/a', '/b'], history);
  expect(xs).toEqual([1, 2, 3]);
  expect(cols[0]).toEqual([10, 12, 14]);
  expect(cols[1]).toEqual([5, null, 7]);
});

test('alignHzSeries: column order follows topic order and unknown topics are all-null', () => {
  const history = new Map<string, MetricSample[]>([['/a', [s(1000, 9)]]]);
  const { xs, cols } = alignHzSeries(['/missing', '/a'], history);
  expect(xs).toEqual([1]);
  expect(cols).toEqual([[null], [9]]);
});

test('alignHzSeries: union of disjoint tick sets, each null outside its own ticks', () => {
  const history = new Map<string, MetricSample[]>([
    ['/a', [s(1000, 1)]],
    ['/b', [s(2000, 2)]],
  ]);
  const { xs, cols } = alignHzSeries(['/a', '/b'], history);
  expect(xs).toEqual([1, 2]);
  expect(cols).toEqual([
    [1, null],
    [null, 2],
  ]);
});

test('toggleTopic: adds when absent, removes when present, preserves order', () => {
  expect(toggleTopic([], '/a')).toEqual(['/a']);
  expect(toggleTopic(['/a'], '/b')).toEqual(['/a', '/b']);
  expect(toggleTopic(['/a', '/b'], '/a')).toEqual(['/b']);
});

test('toggleTopic: adding beyond the MAX_SERIES cap is a no-op; removing still works at cap', () => {
  const full = Array.from({ length: MAX_SERIES }, (_, i) => `/t${i}`);
  expect(full).toHaveLength(6);
  expect(toggleTopic(full, '/new')).toBe(full); // unchanged reference — no-op
  expect(toggleTopic(full, '/t0')).toEqual(full.slice(1)); // remove is allowed at cap
});

test('paletteColor: cycles and covers 6 distinct colours', () => {
  const first6 = Array.from({ length: MAX_SERIES }, (_, i) => paletteColor(i));
  expect(new Set(first6).size).toBe(6);
  expect(paletteColor(MAX_SERIES)).toBe(paletteColor(0)); // wraps
});

test('buildLabelMap: disambiguates topics sharing a trailing segment', () => {
  const map = buildLabelMap(['/head/camera/image', '/hand/camera/image', '/hsrb/joint_states']);
  expect(map.get('/head/camera/image')).toBe('head/camera/image');
  expect(map.get('/hand/camera/image')).toBe('hand/camera/image');
  // Unique trailing segment collapses to the short name.
  expect(map.get('/hsrb/joint_states')).toBe('joint_states');
});

test('metric registry: the four v1 metrics are offered and each selects its own field', () => {
  expect(MONITOR_METRICS.map((m) => m.key)).toEqual(['hz', 'bw', 'gap', 'rate']);
  const one = sample(1000, { hz: 30, bw: 1.5, gap: 12, rate: 95 });
  expect(metricDef('hz').select(one)).toBe(30);
  expect(metricDef('bw').select(one)).toBe(1.5);
  expect(metricDef('gap').select(one)).toBe(12);
  expect(metricDef('rate').select(one)).toBe(95);
  // Only the frequency metric carries the expected_hz/warn-below footer stats.
  expect(metricDef('hz').hzLike).toBe(true);
  expect(metricDef('bw').hzLike).toBeUndefined();
  // rate advertises the "needs expected_hz" empty-state note.
  expect(metricDef('rate').note).toMatch(/expected_hz/);
});

test('alignMetricSeries: selects the chosen metric column, not hz', () => {
  const history = new Map<string, MetricSample[]>([
    ['/a', [sample(1000, { hz: 10, bw: 2 }), sample(2000, { hz: 12, bw: 3 })]],
  ]);
  const { xs, cols } = alignMetricSeries(['/a'], history, metricDef('bw').select);
  expect(xs).toEqual([1, 2]);
  expect(cols).toEqual([[2, 3]]);
});

test('alignMetricSeries: window trims samples older than nowMs - ms before aligning', () => {
  const history = new Map<string, MetricSample[]>([
    ['/a', [sample(1000, { hz: 1 }), sample(5000, { hz: 5 }), sample(9000, { hz: 9 })]],
  ]);
  // 30s window at now=9000ms keeps everything; a 5s window keeps only t>=4000.
  const wide = alignMetricSeries(['/a'], history, metricDef('hz').select, { ms: 30_000, nowMs: 9000 });
  expect(wide.xs).toEqual([1, 5, 9]);
  const narrow = alignMetricSeries(['/a'], history, metricDef('hz').select, { ms: 5_000, nowMs: 9000 });
  expect(narrow.xs).toEqual([5, 9]);
  expect(narrow.cols).toEqual([[5, 9]]);
});

test('windowMs: maps the toggle ids to milliseconds (default 1m)', () => {
  expect(windowMs('30s')).toBe(30_000);
  expect(windowMs('1m')).toBe(60_000);
  expect(windowMs('5m')).toBe(300_000);
});

test('hasAnyValue: true when any column has a non-null, false for all-null (empty-note trigger)', () => {
  expect(hasAnyValue([[null, 2], [null, null]])).toBe(true);
  expect(hasAnyValue([[null, null], [null]])).toBe(false);
  expect(hasAnyValue([])).toBe(false);
});
