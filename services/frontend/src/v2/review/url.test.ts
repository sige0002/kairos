import { expect, test } from 'vitest';
import { readReviewSearch, writeReviewSearch } from './url';
test('round trips review search URL', () => {
  history.replaceState(
    {},
    '',
    '/?q=pick&condition=left&quality=good&result=failure&from=2026-08-01T00%3A00%3A00.000Z&cursor=c1',
  );
  expect(readReviewSearch()).toMatchObject({
    q: 'pick',
    condition: 'left',
    quality: 'good',
    result: 'failure',
    from: '2026-08-01T00:00:00.000Z',
    cursor: 'c1',
  });
  writeReviewSearch({ ...readReviewSearch(), q: '', cursor: null });
  expect(location.search).not.toContain('q=');
});

test('preserves shell route parameters while replacing Review-owned keys', () => {
  history.replaceState({}, '', '/?tab=review&solo=1&q=old&condition=left');

  writeReviewSearch({
    q: 'pick',
    operator: null,
    batch: null,
    quality: null,
    result: null,
    condition: null,
    from: null,
    to: null,
    cursor: null,
  });

  expect(window.location.search).toBe('?tab=review&solo=1&q=pick');
});

test('drops malformed and non-UTC filters instead of issuing a broader surprise query', () => {
  history.replaceState({}, '', '/?quality=bad&result=maybe&from=2026-08-01&to=nope');
  expect(readReviewSearch()).toMatchObject({
    quality: null,
    result: null,
    from: null,
    to: null,
  });
});
