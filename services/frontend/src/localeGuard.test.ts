// The POSIX-locale repair (H-3, 2026-08-12): Chromium on some Linux setups
// reports navigator.language = "en-US@posix", which uPlot feeds into
// Intl.NumberFormat at module scope — a RangeError that blanks the whole
// console before anything renders.

import { expect, test } from 'vitest';
import { repairedLanguageTag } from './localeGuard';

test('a valid tag needs no repair', () => {
  expect(repairedLanguageTag('en-US')).toBeNull();
  expect(repairedLanguageTag('ja')).toBeNull();
});

test('a POSIX-suffixed tag is stripped to its BCP-47 core', () => {
  expect(repairedLanguageTag('en-US@posix')).toBe('en-US');
  expect(repairedLanguageTag('ja_JP@ujis')).toBe('ja-JP');
});

test('an unrepairable tag falls back to en-US', () => {
  expect(repairedLanguageTag('C')).toBe('en-US');
  expect(repairedLanguageTag('!!')).toBe('en-US');
});
