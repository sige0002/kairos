import { expect, test } from 'vitest';
import {
  type SignalReportExt,
  type SignalTopicReportExt,
  aggregateBins,
  binColor,
  collectEdgeRows,
  collectLossRows,
  episodeSpanNs,
  formatContinuity,
  formatNsShort,
  formatSecondsShort,
  globalNsToVideoSeconds,
  intervalsOverlap,
  topicActiveRangeNs,
  totalLossTruncated,
} from './signalReport';

const MS = 1_000_000;

test('global↔video sync maps linearly by fraction and clamps', () => {
  // 60s episode ↔ 10s video: halfway through the episode is 5s into the video.
  expect(globalNsToVideoSeconds(30e9, 60e9, 10)).toBe(5);
  // Clamp out-of-range inputs to the valid span.
  expect(globalNsToVideoSeconds(999e9, 60e9, 10)).toBe(10);
  expect(globalNsToVideoSeconds(-1e9, 60e9, 10)).toBe(0);
  // Degenerate durations/spans never divide by zero.
  expect(globalNsToVideoSeconds(5e9, 0, 10)).toBe(0);
  expect(globalNsToVideoSeconds(5e9, 60e9, 0)).toBe(0);
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

test('binColor: empty in-range bin is red ONLY for a dense topic (emptyIsLoss)', () => {
  const args = { binIndex: 5, binNs: 10, density: 0, activeStartNs: 0, activeEndNs: 100, lossEvents: [] };
  expect(binColor({ ...args, emptyIsLoss: true })).toBe('red');
  // A sparse topic legitimately leaves bins empty (measured: ~10ms bins vs
  // 20-30ms message periods) — emptiness is not evidence of loss there.
  expect(binColor(args)).toBe('green');
  expect(binColor({ ...args, emptyIsLoss: false })).toBe('green');
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

// ---- Aggregated integrity timeline -------------------------------------------

// Two topics on a 40ms span, 4 bins of 10ms:
//  /a  active the whole span, empty (red) at bin 2, else data
//  /b  active only [20,40) (gray at bins 0-1), a minor event over bin 3
function aggReport(): SignalReportExt {
  return extReport(
    {
      '/a': extTopic({
        bins: { count: 4, bin_ns: 10 * MS, densities: [3, 3, 0, 3] },
      }),
      '/b': extTopic({
        start_offset_ns: 20 * MS,
        edges: { start_delay_ns: 20 * MS, end_early_ns: 0 },
        bins: { count: 4, bin_ns: 10 * MS, densities: [0, 0, 2, 2] },
        loss_events: [
          { start_ns: 32 * MS, duration_ns: 4 * MS, estimated_lost: 1, severity: 'minor' },
        ],
      }),
    },
    40 * MS,
  );
}

test('aggregateBins takes the worst per-topic colour per bin and names the degraded', () => {
  const bins = aggregateBins(aggReport());
  expect(bins.map((b) => b.color)).toEqual(['green', 'green', 'red', 'amber']);
  expect(bins[2]!.degraded).toEqual(['/a']); // /a silent; /b's bin 2 is fine
  expect(bins[3]!.degraded).toEqual(['/b']); // /b's minor event; /a fine
  expect(bins[0]!.degraded).toEqual([]); // /b inactive (gray) is NOT degraded
  expect(bins.map((b) => b.startNs)).toEqual([0, 10 * MS, 20 * MS, 30 * MS]);
});

test('aggregateBins is gray only when no topic is active', () => {
  const report = extReport(
    {
      '/late': extTopic({
        start_offset_ns: 20 * MS,
        edges: { start_delay_ns: 20 * MS, end_early_ns: 0 },
        bins: { count: 4, bin_ns: 10 * MS, densities: [0, 0, 2, 2] },
      }),
    },
    40 * MS,
  );
  expect(aggregateBins(report).map((b) => b.color)).toEqual([
    'gray',
    'gray',
    'green',
    'green',
  ]);
});

test('aggregateBins never reds a sparse topic for expected emptiness', () => {
  // median non-zero density 1 (< EMPTY_RED_MIN_MEDIAN): alternating empty bins
  // are this topic's normal operation, so the lane stays green, not red.
  const sparse = extReport(
    {
      '/slow': extTopic({
        bins: { count: 4, bin_ns: 10 * MS, densities: [1, 0, 1, 0] },
      }),
    },
    40 * MS,
  );
  expect(aggregateBins(sparse).map((b) => b.color)).toEqual([
    'green',
    'green',
    'green',
    'green',
  ]);
});

test('aggregateBins skips topics without bins and is empty without span/bins', () => {
  const mixed = extReport(
    {
      '/nobins': extTopic({ bins: null }),
      '/a': extTopic({ bins: { count: 2, bin_ns: 20 * MS, densities: [1, 1] } }),
    },
    40 * MS,
  );
  expect(aggregateBins(mixed)).toHaveLength(2);
  expect(aggregateBins(extReport({ '/nobins': extTopic({ bins: null }) }, 40 * MS))).toEqual([]);
  expect(aggregateBins({ topics: {} })).toEqual([]);
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
