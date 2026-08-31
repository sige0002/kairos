// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
import { expect, test } from 'vitest';
import { resolveTabId, tabLabel, V2_TABS } from './tabs';

test('tab routes retain stable ids while labels use a presentation lookup', () => {
  expect(V2_TABS.map((tab) => tab.id)).toEqual([
    'collect',
    'review',
    'datasets',
    'validation',
    'monitor',
    'settings',
  ]);
  expect(V2_TABS.every((tab) => 'label' in tab)).toBe(false);
  expect(tabLabel('review')).toBe('Review');
  expect(resolveTabId('graph')).toBe('monitor');
});
