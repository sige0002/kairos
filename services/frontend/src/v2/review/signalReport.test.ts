import { expect, test } from 'vitest';
import type { SignalTopicReport } from '../../api/types';
import {
  type SignalReportExt,
  type SignalTopicReportExt,
  binColor,
  chartXToVideoTime,
  collectEdgeRows,
  collectLossRows,
  elapsedSeconds,
  episodeSpanNs,
  episodeSpanSec,
  formatContinuity,
  formatNsShort,
  formatSecondsShort,
  globalNsToChartSec,
  greenIntensity,
  intervalsOverlap,
  medianNonZero,
  numericFieldPaths,
  signalToUplot,
  topicActiveRangeNs,
  totalLossTruncated,
  videoTimeToChartX,
} from './signalReport';

const MS = 1_000_000;

function topic(over: Partial<SignalTopicReport> = {}): SignalTopicReport {
  return {
    t_ns: [0, 1_000_000_000, 2_000_000_000],
    fields: { 'position[0]': [0.1, 0.2, 0.3], velocity: [1, null, 3] },
    ...over,
  };
}

test('elapsedSeconds is 0-based regardless of absolute vs relative t_ns', () => {
  expect(elapsedSeconds([0, 1e9, 2e9])).toEqual([0, 1, 2]);
  // Absolute epoch-ish nanoseconds: still 0-based after subtracting t[0].
  expect(elapsedSeconds([1_700_000_000_000_000_000, 1_700_000_000_500_000_000])).toEqual([
    0, 0.5,
  ]);
  expect(elapsedSeconds([])).toEqual([]);
});

test('episodeSpanSec covers first→last sample; 0 when under 2 points', () => {
  expect(episodeSpanSec([0, 2e9])).toBe(2);
  expect(episodeSpanSec([5e9])).toBe(0);
  expect(episodeSpanSec([])).toBe(0);
});

test('signalToUplot builds AlignedData: elapsed-seconds x + one y per field', () => {
  const { data, fields } = signalToUplot(topic(), ['position[0]', 'velocity']);
  expect(fields).toEqual(['position[0]', 'velocity']);
  expect(data).toEqual([
    [0, 1, 2],
    [0.1, 0.2, 0.3],
    [1, null, 3], // nulls pass through (gaps in the plotted line)
  ]);
});

test('signalToUplot drops unknown fields and preserves selection order', () => {
  const { data, fields } = signalToUplot(topic(), ['velocity', 'nope', 'position[0]']);
  expect(fields).toEqual(['velocity', 'position[0]']);
  expect(data).toEqual([
    [0, 1, 2],
    [1, null, 3],
    [0.1, 0.2, 0.3],
  ]);
});

test('signalToUplot pads/trims a field column to the x length', () => {
  const short = topic({ fields: { a: [1] } });
  expect(signalToUplot(short, ['a']).data).toEqual([
    [0, 1, 2],
    [1, null, null],
  ]);
  const long = topic({ fields: { a: [1, 2, 3, 4, 5] } });
  expect(signalToUplot(long, ['a']).data).toEqual([
    [0, 1, 2],
    [1, 2, 3],
  ]);
});

test('signalToUplot with no fields selected yields x only', () => {
  expect(signalToUplot(topic(), []).data).toEqual([[0, 1, 2]]);
});

test('numericFieldPaths lists the topic field keys', () => {
  expect(numericFieldPaths(topic())).toEqual(['position[0]', 'velocity']);
  expect(numericFieldPaths(topic({ fields: {} }))).toEqual([]);
});

test('video↔chart sync maps linearly by fraction and clamps', () => {
  // 10s video ↔ 60s episode: halfway through the video is 30s into the chart.
  expect(videoTimeToChartX(5, 10, 60)).toBe(30);
  expect(chartXToVideoTime(30, 60, 10)).toBe(5);
  // Clamp out-of-range inputs to the valid span.
  expect(videoTimeToChartX(15, 10, 60)).toBe(60);
  expect(videoTimeToChartX(-1, 10, 60)).toBe(0);
  expect(chartXToVideoTime(999, 60, 10)).toBe(10);
  // Degenerate durations/spans never divide by zero.
  expect(videoTimeToChartX(5, 0, 60)).toBe(0);
  expect(chartXToVideoTime(5, 0, 10)).toBe(0);
});

test('video↔chart sync round-trips a mid-point', () => {
  const x = videoTimeToChartX(7, 20, 90);
  expect(chartXToVideoTime(x, 90, 20)).toBeCloseTo(7);
});

test('formatContinuity is a percent, or n/a when unknown', () => {
  expect(formatContinuity(0.98)).toBe('98%');
  expect(formatContinuity(1)).toBe('100%');
  expect(formatContinuity(0)).toBe('0%');
  expect(formatContinuity(null)).toBe('n/a');
  expect(formatContinuity(undefined)).toBe('n/a');
  expect(formatContinuity(NaN)).toBe('n/a');
});

// ---- Loss-location view (v1.1) ----------------------------------------------

function extTopic(over: Partial<SignalTopicReportExt> = {}): SignalTopicReportExt {
  return { t_ns: [0], fields: {}, ...over };
}

function extReport(topics: Record<string, SignalTopicReportExt>, spanNs: number): SignalReportExt {
  return { span: { duration_ns: spanNs }, topics };
}

test('episodeSpanNs reads the global span, 0 when absent', () => {
  expect(episodeSpanNs(extReport({}, 20 * MS))).toBe(20 * MS);
  expect(episodeSpanNs({ topics: {} })).toBe(0);
  expect(episodeSpanNs({ span: null, topics: {} })).toBe(0);
});

test('topicActiveRangeNs is [start_offset, span − end_early]', () => {
  const t = extTopic({ start_offset_ns: 200 * MS, edges: { start_delay_ns: 200 * MS, end_early_ns: 100 * MS } });
  expect(topicActiveRangeNs(t, 500 * MS)).toEqual([200 * MS, 400 * MS]);
  // Missing offset/edges default to [0, span].
  expect(topicActiveRangeNs(extTopic(), 500 * MS)).toEqual([0, 500 * MS]);
});

test('intervalsOverlap is half-open (touching edges do not overlap)', () => {
  expect(intervalsOverlap(0, 10, 5, 15)).toBe(true);
  expect(intervalsOverlap(0, 10, 10, 20)).toBe(false); // touch at 10
  expect(intervalsOverlap(2, 8, 0, 20)).toBe(true); // contained
  expect(intervalsOverlap(0, 10, 20, 30)).toBe(false); // disjoint
});

test('binColor: gray outside the topic active range (even when empty)', () => {
  expect(
    binColor({ binIndex: 0, binNs: 10, density: 0, activeStartNs: 50, activeEndNs: 100, lossEvents: [] }),
  ).toBe('gray');
});

test('binColor: green inside active range with data and no events', () => {
  expect(
    binColor({ binIndex: 5, binNs: 10, density: 3, activeStartNs: 0, activeEndNs: 100, lossEvents: [] }),
  ).toBe('green');
});

test('binColor: red for an empty bin inside the active range', () => {
  expect(
    binColor({ binIndex: 5, binNs: 10, density: 0, activeStartNs: 0, activeEndNs: 100, lossEvents: [] }),
  ).toBe('red');
});

test('binColor: red when a major event overlaps, amber for a minor one', () => {
  const major = [{ start_ns: 48, duration_ns: 6, estimated_lost: 5, severity: 'major' as const }];
  const minor = [{ start_ns: 48, duration_ns: 6, estimated_lost: 1, severity: 'minor' as const }];
  const base = { binIndex: 5, binNs: 10, density: 4, activeStartNs: 0, activeEndNs: 100 };
  // bin 5 spans [50, 60); the event [48, 54) overlaps it.
  expect(binColor({ ...base, lossEvents: major })).toBe('red');
  expect(binColor({ ...base, lossEvents: minor })).toBe('amber');
});

test('binColor: a major event outranks a minor overlap in the same bin', () => {
  const both = [
    { start_ns: 50, duration_ns: 2, estimated_lost: 1, severity: 'minor' as const },
    { start_ns: 52, duration_ns: 5, estimated_lost: 5, severity: 'major' as const },
  ];
  expect(
    binColor({ binIndex: 5, binNs: 10, density: 4, activeStartNs: 0, activeEndNs: 100, lossEvents: both }),
  ).toBe('red');
});

test('medianNonZero ignores empty bins', () => {
  expect(medianNonZero([0, 0, 3, 0, 5])).toBe(4);
  expect(medianNonZero([2])).toBe(2);
  expect(medianNonZero([1, 2, 3])).toBe(2);
  expect(medianNonZero([0, 0, 0])).toBe(0);
});

test('greenIntensity is density/median clamped, 1 when median is 0', () => {
  expect(greenIntensity(5, 10)).toBe(0.5);
  expect(greenIntensity(20, 10)).toBe(1);
  expect(greenIntensity(0, 10)).toBe(0);
  expect(greenIntensity(3, 0)).toBe(1);
});

test('globalNsToChartSec offsets by the charted topic start_offset', () => {
  expect(globalNsToChartSec(5e9, 2e9)).toBe(3);
  // A bin before the charted topic began yields a negative (caller clamps).
  expect(globalNsToChartSec(1e9, 2e9)).toBe(-1);
});

test('collectLossRows flattens every topic and sorts by global start', () => {
  const report = extReport(
    {
      '/a': extTopic({
        loss_events: [{ start_ns: 300 * MS, duration_ns: 20 * MS, estimated_lost: 2, severity: 'minor' }],
      }),
      '/b': extTopic({
        loss_events: [{ start_ns: 100 * MS, duration_ns: 40 * MS, estimated_lost: 5, severity: 'major' }],
      }),
    },
    500 * MS,
  );
  const rows = collectLossRows(report);
  expect(rows.map((r) => [r.topic, r.start_ns])).toEqual([
    ['/b', 100 * MS],
    ['/a', 300 * MS],
  ]);
});

test('collectEdgeRows emits only nonzero edges, positioned on the global axis', () => {
  const report = extReport(
    {
      '/a': extTopic({ edges: { start_delay_ns: 0, end_early_ns: 100 * MS } }),
      '/b': extTopic({ edges: { start_delay_ns: 200 * MS, end_early_ns: 0 } }),
    },
    500 * MS,
  );
  const edges = collectEdgeRows(report);
  // start_delay sits at global 0; end_early at span − end_early = 400 ms.
  expect(edges).toEqual([
    { topic: '/a', kind: 'end_early', globalNs: 400 * MS, durationNs: 100 * MS },
    { topic: '/b', kind: 'start_delay', globalNs: 0, durationNs: 200 * MS },
  ].sort((x, y) => x.globalNs - y.globalNs));
});

test('totalLossTruncated sums per-topic drops', () => {
  const report = extReport(
    { '/a': extTopic({ loss_events_truncated: 50 }), '/b': extTopic({ loss_events_truncated: 3 }) },
    500 * MS,
  );
  expect(totalLossTruncated(report)).toBe(53);
  expect(totalLossTruncated(extReport({ '/a': extTopic() }, 500 * MS))).toBe(0);
});

test('formatNsShort / formatSecondsShort are compact human labels', () => {
  expect(formatNsShort(420 * MS)).toBe('420ms');
  expect(formatNsShort(1350 * MS)).toBe('1.35s');
  expect(formatSecondsShort(4200 * MS)).toBe('4.20s');
  expect(formatSecondsShort(0)).toBe('0.00s');
});
