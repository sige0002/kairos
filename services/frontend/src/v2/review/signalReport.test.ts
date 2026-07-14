import { expect, test } from 'vitest';
import type { SignalTopicReport } from '../../api/types';
import {
  chartXToVideoTime,
  elapsedSeconds,
  episodeSpanSec,
  formatContinuity,
  numericFieldPaths,
  signalToUplot,
  videoTimeToChartX,
} from './signalReport';

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
