// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
import { expect, test } from 'vitest';
import { APP_LOCALES, resources } from './index';

function keyPaths(value: object, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof child === 'string' ? [path] : keyPaths(child, path);
  });
}

test('every supported locale has the English resource shape', () => {
  const englishKeys = keyPaths(resources.en).sort();
  for (const locale of APP_LOCALES) {
    expect(keyPaths(resources[locale]).sort()).toEqual(englishKeys);
  }
});

test('feature namespaces remain explicit rather than one unbounded resource', () => {
  expect(Object.keys(resources.en).sort()).toEqual([
    'collect',
    'common',
    'datasets',
    'monitor',
    'review',
    'settings',
    'validation',
  ]);
});
