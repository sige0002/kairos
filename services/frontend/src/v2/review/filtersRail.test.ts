// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test } from 'vitest';
import {
  setFiltersCollapsed,
  toggleFiltersCollapsed,
  useFiltersCollapsed,
} from './filtersRail';

const KEY = 'kairos.v2.review.filtersCollapsed.v1';

beforeEach(() => {
  setFiltersCollapsed(false);
  window.localStorage.removeItem(KEY);
});
afterEach(() => {
  setFiltersCollapsed(false);
  window.localStorage.removeItem(KEY);
});

test('toggle flips the value, persists it, and notifies subscribers', () => {
  const { result } = renderHook(() => useFiltersCollapsed());
  expect(result.current).toBe(false);

  act(() => toggleFiltersCollapsed());
  expect(result.current).toBe(true);
  expect(window.localStorage.getItem(KEY)).toBe('1');

  act(() => toggleFiltersCollapsed());
  expect(result.current).toBe(false);
  // Removed (not "0") so the default is a clean absent key.
  expect(window.localStorage.getItem(KEY)).toBeNull();
});

test('setFiltersCollapsed is idempotent', () => {
  setFiltersCollapsed(true);
  expect(window.localStorage.getItem(KEY)).toBe('1');
  setFiltersCollapsed(true);
  expect(window.localStorage.getItem(KEY)).toBe('1');
});
