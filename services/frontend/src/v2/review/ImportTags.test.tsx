// Bulk labels on an import.
//
// A bag recorded outside kairos carries no operator or task of its own — the
// recorder stamps those on a take it started itself — so an import lands
// unlabelled, and unlabelled means invisible to every operator/task filter.
// One set of labels applies to every bag of the request; the server writes them
// into each capture's birth manifest (not the §4.3 review override).
//
// The refusal path is deliberately NOT "wait for the 400": a 400 is already how
// a per-bag problem arrives (a missing .mcap), so a bad label is caught here,
// before any request, where it cannot be confused with one.

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { ImportBagsDialog } from './ImportBagsDialog';

const SCAN = {
  path: '/data/incoming',
  importable: 2,
  bags: [
    {
      path: '/data/incoming/a',
      name: 'a',
      importable: true,
      bytes: 91_000_000,
      topics: 16,
      message_count: 27016,
      duration_s: 44,
    },
    {
      path: '/data/incoming/b',
      name: 'b',
      importable: true,
      bytes: 12_000_000,
      topics: 8,
      message_count: 900,
      duration_s: 12,
    },
  ],
};

function mockFetch() {
  const posts: Record<string, unknown>[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (url.includes('/imports/scan')) return Promise.resolve(jsonResponse(SCAN));
    if (url.includes('/imports') && (init?.method ?? 'GET') === 'POST') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      posts.push(body);
      return Promise.resolve(jsonResponse({ capture_id: `cap-${body.source_path}` }, 202));
    }
    if (url.includes('/plans')) return Promise.resolve(jsonResponse({ projects: [] }));
    return Promise.resolve(jsonResponse({}));
  });
  return { posts };
}

beforeEach(() => setApiBase('/api/v1'));
afterEach(() => vi.restoreAllMocks());

/** Open the dialog, scan, and land on the bag list with both bags selected. */
async function scan() {
  renderWithClient(
    <ImportBagsDialog open onClose={() => {}} onImported={() => {}} />,
  );
  fireEvent.change(screen.getByTestId('import-path'), {
    target: { value: '/data/incoming' },
  });
  fireEvent.click(screen.getByTestId('import-scan'));
  await screen.findByTestId('import-summary');
}

test('the typed labels ride along on every bag of the import', async () => {
  const { posts } = mockFetch();
  await scan();

  fireEvent.change(screen.getByTestId('import-tag-operator'), {
    target: { value: '  alice  ' },
  });
  fireEvent.change(screen.getByTestId('import-tag-task'), {
    target: { value: 'pick-and-place' },
  });
  fireEvent.change(screen.getByTestId('import-tag-robot'), {
    target: { value: 'myrobot' },
  });
  fireEvent.click(screen.getByTestId('import-run'));

  await waitFor(() => expect(posts).toHaveLength(2));
  // Same labels on both — one set for the request, trimmed.
  for (const body of posts) {
    expect(body).toMatchObject({
      operator: 'alice',
      task: 'pick-and-place',
      robot: 'myrobot',
    });
  }
  expect(posts.map((p) => p.source_path)).toEqual([
    '/data/incoming/a',
    '/data/incoming/b',
  ]);
});

test('untouched fields are omitted, not sent as empty labels', async () => {
  const { posts } = mockFetch();
  await scan();

  // Only one filled in; the other two left alone (and one is whitespace, which
  // is the same as untouched — an empty label would be a label that says
  // nothing rather than no label at all).
  fireEvent.change(screen.getByTestId('import-tag-operator'), {
    target: { value: 'alice' },
  });
  fireEvent.change(screen.getByTestId('import-tag-task'), {
    target: { value: '   ' },
  });
  fireEvent.click(screen.getByTestId('import-run'));

  await waitFor(() => expect(posts).toHaveLength(2));
  expect(posts[0]).toMatchObject({ operator: 'alice' });
  expect(posts[0]).not.toHaveProperty('task');
  expect(posts[0]).not.toHaveProperty('robot');
});

test('an import with no labels sends exactly what it always did', async () => {
  const { posts } = mockFetch();
  await scan();

  fireEvent.click(screen.getByTestId('import-run'));

  await waitFor(() => expect(posts).toHaveLength(2));
  expect(posts[0]).toEqual({ source_path: '/data/incoming/a', move: false });
});

test('a refused label is stated beside the field and nothing is imported', async () => {
  const { posts } = mockFetch();
  await scan();

  fireEvent.change(screen.getByTestId('import-tag-task'), {
    target: { value: 'pick/place' },
  });
  fireEvent.click(screen.getByTestId('import-run'));

  const error = await screen.findByTestId('import-tag-error');
  expect(error).toHaveTextContent(/cannot contain/i);
  expect(error).toHaveTextContent(/Nothing was imported/i);
  // Not one request went out, and what was typed is still there to fix.
  expect(posts).toHaveLength(0);
  expect(screen.getByTestId('import-tag-task')).toHaveValue('pick/place');

  // Editing clears the refusal — it was about what was there before.
  fireEvent.change(screen.getByTestId('import-tag-task'), {
    target: { value: 'pick-place' },
  });
  await waitFor(() => expect(screen.queryByTestId('import-tag-error')).toBeNull());

  fireEvent.click(screen.getByTestId('import-run'));
  await waitFor(() => expect(posts).toHaveLength(2));
  expect(posts[0]).toMatchObject({ task: 'pick-place' });
});

test('an over-long label is refused too, by bytes rather than characters', async () => {
  const { posts } = mockFetch();
  await scan();

  // 128 two-byte characters = 256 bytes: inside a 255-CHARACTER budget and
  // outside a 255-BYTE one, which is the rule the contract states.
  fireEvent.change(screen.getByTestId('import-tag-operator'), {
    target: { value: 'é'.repeat(128) },
  });
  fireEvent.click(screen.getByTestId('import-run'));

  expect(await screen.findByTestId('import-tag-error')).toHaveTextContent(
    /longer than 255 bytes/i,
  );
  expect(posts).toHaveLength(0);
});
