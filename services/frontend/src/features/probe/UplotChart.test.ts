// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// yRange is the custom uPlot y-scale range fn (a custom fn bypasses uPlot's own
// padding). The regression here: a single FLAT series (constant value, e.g. a
// status/error field pinned at 0) collapsed the scale to min === max and the
// chart drew nothing — until a second, different-valued series widened it.
import { expect, test } from 'vitest';
import { yRange } from './UplotChart';

test('flat series at zero pads to a renderable range', () => {
  expect(yRange(0, 0, [])).toEqual([-1, 1]);
});

test('flat series at a non-zero value pads relative to the value', () => {
  const [lo, hi] = yRange(100, 100, []);
  expect(lo).toBeCloseTo(90);
  expect(hi).toBeCloseTo(110);
});

test('a varying series passes through untouched', () => {
  expect(yRange(1, 5, [])).toEqual([1, 5]);
});

test('reference lines extend the data range', () => {
  expect(yRange(1, 5, [30])).toEqual([1, 30]);
  expect(yRange(1, 5, [-2])).toEqual([-2, 5]);
});

test('flat data equal to the only reference line still pads', () => {
  expect(yRange(30, 30, [30])).toEqual([27, 33]);
});

test('no data yet: null without refLines, refLine-scaled with them', () => {
  expect(yRange(null, null, [])).toEqual([null, null]);
  expect(yRange(null, null, [10, 20])).toEqual([10, 20]);
  // A single refLine with no data is also a collapsed range — pad it too.
  expect(yRange(null, null, [10])).toEqual([9, 11]);
});
