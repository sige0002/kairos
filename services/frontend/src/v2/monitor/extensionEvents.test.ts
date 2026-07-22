import { expect, test } from 'vitest';
import { chipValue, eventLine, eventTime } from './extensionEvents';

test('eventLine renders slots plus freeform key=value text', () => {
  expect(
    eventLine({ t: 1, kind: 'dark_frame', source: 'ext', topic: '/cam', mean_gray: 12.3 }),
  ).toBe('dark_frame · ext · /cam · mean_gray=12.3');
  // unknown shapes never crash and never render empty
  expect(eventLine({})).toBe('event');
  expect(eventLine({ note: { nested: true } })).toBe('note={"nested":true}');
});

test('eventTime handles missing/bad t honestly', () => {
  expect(eventTime(undefined)).toBe('—');
  expect(eventTime('not-a-number')).toBe('—');
  expect(eventTime(1784750560)).toMatch(/\d/); // locale time, but never '—'
});

test('chipValue stringifies primitives and JSON-encodes the rest', () => {
  expect(chipValue(5)).toBe('5');
  expect(chipValue(true)).toBe('true');
  expect(chipValue(null)).toBe('—');
  expect(chipValue([1, 2])).toBe('[1,2]');
});
