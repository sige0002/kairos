import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { ImportBagsDialog } from './ImportBagsDialog';

const SCAN = {
  path: '/data/incoming',
  importable: 2,
  bags: [
    { path: '/data/incoming/a', name: 'a', importable: true, bytes: 91_000_000, topics: 16, message_count: 27016, duration_s: 44 },
    { path: '/data/incoming/b', name: 'b', importable: true, bytes: 12_000_000, topics: 8, message_count: 900, duration_s: 12 },
    {
      path: '/data/incoming/broken',
      name: 'broken',
      importable: false,
      reason: 'No metadata.yaml in /data/incoming/broken.',
      remedy: 'ros2 bag reindex /data/incoming/broken',
    },
  ],
};

/** Fetch stub: scan returns SCAN; POST /imports succeeds unless the path is in `failing`. */
function mockFetch(failing: string[] = []) {
  const posts: { source_path: string; move: boolean }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (url.includes('/imports/scan')) return Promise.resolve(jsonResponse(SCAN));
    if (url.includes('/imports') && (init?.method ?? 'GET') === 'POST') {
      const body = JSON.parse(String(init?.body)) as { source_path: string; move: boolean };
      posts.push(body);
      if (failing.includes(body.source_path)) {
        return Promise.resolve(
          jsonResponse({ error: { code: 'import_no_mcap', message: 'No .mcap file.' } }, 400),
        );
      }
      return Promise.resolve(jsonResponse({ capture_id: `cap-${body.source_path}` }, 202));
    }
    return Promise.resolve(jsonResponse({}));
  });
  return posts;
}

beforeEach(() => setApiBase('/api/v1'));
afterEach(() => vi.restoreAllMocks());

function open() {
  renderWithClient(
    <ImportBagsDialog open onClose={() => {}} onImported={() => {}} />,
  );
  fireEvent.change(screen.getByTestId('import-path'), {
    target: { value: '/data/incoming' },
  });
  fireEvent.click(screen.getByTestId('import-scan'));
}

test('a scan lists every directory, with the un-importable ones and their remedy', async () => {
  mockFetch();
  open();

  await screen.findByTestId('import-list');
  expect(screen.getByTestId('import-summary')).toHaveTextContent('3 directories found');
  expect(screen.getByTestId('import-summary')).toHaveTextContent('2 can be imported');
  // A rejected directory is REPORTED, never hidden — with what to do about it.
  const broken = screen.getByTestId('import-row-broken');
  expect(broken).toHaveTextContent('No metadata.yaml');
  expect(broken).toHaveTextContent('ros2 bag reindex');
  expect(screen.getByLabelText('import broken')).toBeDisabled();
  // The importable ones are pre-selected: "import this folder" is the case.
  expect(screen.getByTestId('import-run')).toHaveTextContent('Import 2 bags');
});

test('a failing bag is skipped and named — the rest of the run still completes', async () => {
  const posts = mockFetch(['/data/incoming/a']);
  open();
  await screen.findByTestId('import-list');

  fireEvent.click(screen.getByTestId('import-run'));

  await waitFor(() => expect(screen.getByTestId('import-failures')).toBeInTheDocument());
  // Both were attempted: the failure did not abort the run.
  expect(posts.map((p) => p.source_path)).toEqual([
    '/data/incoming/a',
    '/data/incoming/b',
  ]);
  expect(screen.getByTestId('import-failed-a')).toHaveTextContent('No .mcap file.');
  expect(screen.getByTestId('import-failures')).toHaveTextContent('1 folder failed');
  expect(screen.getByTestId('import-row-b')).toHaveTextContent('queued');
});

test('copy is the default; move is sent only when chosen', async () => {
  const posts = mockFetch();
  open();
  await screen.findByTestId('import-list');

  fireEvent.click(screen.getByTestId('import-run'));
  await waitFor(() => expect(posts).toHaveLength(2));
  expect(posts.every((p) => p.move === false)).toBe(true);

  fireEvent.click(screen.getByTestId('import-mode-move'));
  fireEvent.click(screen.getByTestId('import-run'));
  await waitFor(() => expect(posts).toHaveLength(4));
  expect(posts.slice(2).every((p) => p.move === true)).toBe(true);
});

test('a scan error is surfaced, not swallowed', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    jsonResponse(
      { error: { code: 'import_source_missing', message: 'Nothing exists at /nope.' } },
      400,
    ) as Response,
  );
  open();
  expect(await screen.findByTestId('import-scan-error')).toHaveTextContent(
    'Nothing exists at /nope.',
  );
});


test('a folder whose bags are one level down offers the way in, not a dead end', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('2026-08-04')) {
      return Promise.resolve(
        jsonResponse({
          path: '/data/incoming/2026-08-04',
          importable: 1,
          bags: [{ path: '/data/incoming/2026-08-04/s1', name: 's1', importable: true, bytes: 1, topics: 2, message_count: 3 }],
          nested: [],
        }),
      );
    }
    return Promise.resolve(
      jsonResponse({
        path: '/data/incoming',
        importable: 0,
        bags: [],
        nested: [{ path: '/data/incoming/2026-08-04', name: '2026-08-04', bags: 2 }],
      }),
    );
  });

  renderWithClient(<ImportBagsDialog open onClose={() => {}} onImported={() => {}} />);
  fireEvent.change(screen.getByTestId('import-path'), {
    target: { value: '/data/incoming' },
  });
  fireEvent.click(screen.getByTestId('import-scan'));

  // Empty result, but never a dead end: the subfolder that holds them is named.
  const hint = await screen.findByTestId('import-nested-hint');
  expect(hint).toHaveTextContent('No recordings directly here');
  expect(screen.getByTestId('import-nested-2026-08-04')).toHaveTextContent('(2)');

  // One click drills into it — no re-typing the path.
  fireEvent.click(screen.getByTestId('import-nested-2026-08-04'));
  await waitFor(() =>
    expect(screen.getByTestId('import-summary')).toHaveTextContent('1 can be imported'),
  );
  expect(screen.getByTestId('import-path')).toHaveValue('/data/incoming/2026-08-04');
});


test('a double-click on Import does not import everything twice', async () => {
  const posts = mockFetch();
  renderWithClient(<ImportBagsDialog open onClose={() => {}} onImported={() => {}} />);
  fireEvent.change(screen.getByTestId('import-path'), { target: { value: '/data/incoming' } });
  fireEvent.click(screen.getByTestId('import-scan'));
  await screen.findByTestId('import-list');

  // Both clicks land in the same tick: `running` state has not flipped yet, so
  // only a ref can close the window (two runs = two copies of every bag under
  // two capture ids).
  const run = screen.getByTestId('import-run');
  fireEvent.click(run);
  fireEvent.click(run);

  await waitFor(() => expect(posts.length).toBeGreaterThan(0));
  await new Promise((r) => setTimeout(r, 50));
  expect(posts.map((p) => p.source_path)).toEqual([
    '/data/incoming/a',
    '/data/incoming/b',
  ]);
});

test('closing the dialog mid-run stops queueing further imports', async () => {
  // A long-running first import, so the close lands between the two.
  const posts: { source_path: string; move: boolean }[] = [];
  let release: null | (() => void) = null;
  const fire = () => release?.();
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (url.includes('/imports/scan')) return Promise.resolve(jsonResponse(SCAN));
    if (url.includes('/imports') && (init?.method ?? 'GET') === 'POST') {
      const body = JSON.parse(String(init?.body)) as { source_path: string; move: boolean };
      posts.push(body);
      if (posts.length === 1) {
        return new Promise<Response>((resolve) => {
          release = () => resolve(jsonResponse({ capture_id: 'c1' }, 202) as Response);
        });
      }
      return Promise.resolve(jsonResponse({ capture_id: 'c2' }, 202));
    }
    return Promise.resolve(jsonResponse({}));
  });

  const { unmount } = renderWithClient(
    <ImportBagsDialog open onClose={() => {}} onImported={() => {}} />,
  );
  fireEvent.change(screen.getByTestId('import-path'), { target: { value: '/data/incoming' } });
  fireEvent.click(screen.getByTestId('import-scan'));
  await screen.findByTestId('import-list');
  fireEvent.click(screen.getByTestId('import-run'));
  await waitFor(() => expect(posts).toHaveLength(1));

  unmount();
  fire();
  await new Promise((r) => setTimeout(r, 50));

  // The in-flight one was already sent (the server owns it now); the SECOND is
  // never queued behind a screen nobody is watching.
  expect(posts.map((p) => p.source_path)).toEqual(['/data/incoming/a']);
});
