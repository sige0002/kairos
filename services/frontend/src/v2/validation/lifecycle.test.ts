import { expect, test } from 'vitest';
import { lifecycleForIndex, lifecycleTone } from './lifecycle';

test('the first pipeline is Standard, the second Candidate, the rest Experimental', () => {
  expect(lifecycleForIndex(0)).toBe('Standard');
  expect(lifecycleForIndex(1)).toBe('Candidate');
  expect(lifecycleForIndex(2)).toBe('Experimental');
  expect(lifecycleForIndex(9)).toBe('Experimental');
});

test('each lifecycle maps to the design mock tone', () => {
  expect(lifecycleTone('Standard')).toBe('green');
  expect(lifecycleTone('Candidate')).toBe('teal');
  expect(lifecycleTone('Experimental')).toBe('amber');
  expect(lifecycleTone('Draft')).toBe('gray');
});
