// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
import { expect, test } from 'vitest';
import { formatBatchLabel, qualityLabel, taskResultLabel } from './episodeChips';

test('quality and task presentation maps stable values at the rendering boundary', () => {
  expect(qualityLabel('needs_review')).toBe('Needs review');
  expect(taskResultLabel('failure')).toBe('Failure');
});

test('formatBatchLabel renders "MM/DD · #N" from a seq + date', () => {
  expect(formatBatchLabel(3, '2026-07-13T09:00:00Z')).toBe('07/13 · #3');
});

test('formatBatchLabel drops the date part when no valid date is given', () => {
  expect(formatBatchLabel(5, null)).toBe('#5');
  expect(formatBatchLabel(5, 'not-a-date')).toBe('#5');
});

test('formatBatchLabel returns the fallback when the seq is null/undefined', () => {
  expect(formatBatchLabel(null, '2026-07-13T09:00:00Z')).toBe('—');
  expect(formatBatchLabel(undefined)).toBe('—');
  expect(formatBatchLabel(null, null, '#7')).toBe('#7');
});
