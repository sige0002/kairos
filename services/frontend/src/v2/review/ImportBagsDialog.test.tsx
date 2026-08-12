// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import {
  __resetImportWatchMs,
  __setImportWatchMs,
  ImportBagsDialog,
} from './ImportBagsDialog';

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

/** Fetch stub: scan returns SCAN; POST /imports 202s (unless the path is in
 *  `failing`) with an import_id, and GET /imports/{id} reports the copy —
 *  one `running` read, then `succeeded` (or `failed` for `copyFails` paths),
 *  modelling the real registry (S3-2: the 202 is "queued", not "done"). */
function mockFetch(failing: string[] = [], copyFails: string[] = []) {
  const posts: { source_path: string; move: boolean }[] = [];
  const records: Record<
    string,
    { source: string; reads: number; fails: boolean }
  > = {};
  let nextImport = 1;
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
      const importId = `imp-${nextImport++}`;
      records[importId] = {
        source: body.source_path,
        reads: 0,
        fails: copyFails.includes(body.source_path),
      };
      return Promise.resolve(
        jsonResponse(
          {
            import_id: importId,
            capture_id: `cap-${body.source_path}`,
            state: 'running',
            bytes_total: 100,
          },
          202,
        ),
      );
    }
    const status = url.match(/\/imports\/(imp-\d+)$/);
    if (status) {
      const rec = records[status[1]!]!;
      rec.reads += 1;
      if (rec.reads <= 1) {
        return Promise.resolve(
          jsonResponse({
            import_id: status[1],
            capture_id: `cap-${rec.source}`,
            state: 'running',
            bytes_total: 100,
            bytes_copied: 50,
          }),
        );
      }
      return Promise.resolve(
        jsonResponse({
          import_id: status[1],
          capture_id: `cap-${rec.source}`,
          state: rec.fails ? 'failed' : 'succeeded',
          bytes_total: 100,
          bytes_copied: rec.fails ? 50 : 100,
          error: rec.fails
            ? { code: 'import_copy_failed', message: 'The copy died in staging.' }
            : null,
        }),
      );
    }
    return Promise.resolve(jsonResponse({}));
  });
  return posts;
}

beforeEach(() => {
  setApiBase('/api/v1');
  // The import watch is a real wall-clock poll; run it fast in tests.
  __setImportWatchMs(5);
});
afterEach(() => {
  __resetImportWatchMs();
  vi.restoreAllMocks();
});

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
  // The ✓ lands only when the server-side copy actually finished (S3-2).
  await waitFor(() =>
    expect(screen.getByTestId('import-row-b')).toHaveTextContent('imported ✓'),
  );
});

test('a copy that dies AFTER the 202 flips its row to failed, not ✓ forever', async () => {
  // The exact S3-2 lie: the old dialog marked a row done at the ack and never
  // looked again, so a copy that died in staging stayed ✓ on screen.
  mockFetch([], ['/data/incoming/a']);
  open();
  await screen.findByTestId('import-list');

  fireEvent.click(screen.getByTestId('import-run'));

  const failed = await screen.findByTestId('import-failed-a');
  expect(failed).toHaveTextContent('The copy died in staging.');
  await waitFor(() =>
    expect(screen.getByTestId('import-row-b')).toHaveTextContent('imported ✓'),
  );
});

test('copy is the default; move is sent only when chosen', async () => {
  const posts = mockFetch();
  open();
  await screen.findByTestId('import-list');

  fireEvent.click(screen.getByTestId('import-run'));
  await waitFor(() => expect(posts).toHaveLength(2));
  expect(posts.every((p) => p.move === false)).toBe(true);

  // The run now watches the server-side copies to their end (S3-2); the next
  // run can only start once the first one finished.
  await waitFor(() => expect(screen.getByTestId('import-run')).not.toBeDisabled());
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


test('a second scan cannot be started while one is in flight', async () => {
  // The reachable half of the out-of-order-scan concern: overlapping scans
  // would let the slower answer describe a folder the operator moved on from.
  // The control itself refuses (a generation counter in runScan covers the
  // other entry points, e.g. the nested-folder hint buttons).
  let release: null | (() => void) = null;
  const fire = () => release?.();
  const scans: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    scans.push(String(input));
    return new Promise<Response>((resolve) => {
      release = () => resolve(jsonResponse(SCAN) as Response);
    });
  });

  renderWithClient(<ImportBagsDialog open onClose={() => {}} onImported={() => {}} />);
  const input = screen.getByTestId('import-path');
  fireEvent.change(input, { target: { value: '/folderA' } });
  fireEvent.click(screen.getByTestId('import-scan'));
  await waitFor(() => expect(screen.getByTestId('import-scan')).toBeDisabled());

  fireEvent.change(input, { target: { value: '/folderB' } });
  fireEvent.click(screen.getByTestId('import-scan'));
  expect(scans).toHaveLength(1);

  fire();
  await screen.findByTestId('import-list');
});

test('editing the path after a scan blocks the import until it is rescanned', async () => {
  mockFetch();
  renderWithClient(<ImportBagsDialog open onClose={() => {}} onImported={() => {}} />);
  fireEvent.change(screen.getByTestId('import-path'), { target: { value: '/data/incoming' } });
  fireEvent.click(screen.getByTestId('import-scan'));
  await screen.findByTestId('import-list');
  expect(screen.getByTestId('import-run')).toBeEnabled();

  fireEvent.change(screen.getByTestId('import-path'), { target: { value: '/data/other' } });

  // The list still describes the OLD folder; importing it while the box says
  // another one is the confusion, so the button waits for a rescan.
  expect(screen.getByTestId('import-stale-scan')).toHaveTextContent('/data/incoming');
  expect(screen.getByTestId('import-run')).toBeDisabled();
});

// `POST /imports` can now answer 409 `already_imported` per bag: the source was
// imported before, and importing it again would make a second copy of the same
// recording under a second capture_id with nothing afterwards to tell them
// apart. The scan already refuses such a folder up front, but the scan is a
// snapshot — another terminal, or an earlier run of this same dialog, can
// import it in between, so the refusal has to hold at POST time too.
//
// WHAT THIS DOES NOT CLAIM, because the test above already does. The bulk
// mechanics — every bag still attempted, the tally, the neighbouring row still
// landing — are pinned by "a failing bag is skipped and named", and the catch
// block is status-agnostic (it reads the error's message and moves on, with no
// branch on the code). So no mutation can redden this test alone, and a copy of
// that test with a different status number would be coverage theatre.
//
// The one thing that IS new is the content: `already_imported` is the only
// refusal here that names ANOTHER capture, and that id is the whole remedy —
// it turns "Failed" into "you already have this, it is over there". A message
// that reached the operator stripped of it would still pass every assertion
// above.
test('the already_imported refusal reaches the operator with the capture it names', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (url.includes('/imports/scan')) return Promise.resolve(jsonResponse(SCAN));
    if (url.includes('/imports') && (init?.method ?? 'GET') === 'POST') {
      const body = JSON.parse(String(init?.body)) as { source_path: string };
      if (body.source_path === '/data/incoming/a') {
        return Promise.resolve(
          jsonResponse(
            {
              error: {
                code: 'already_imported',
                message:
                  '/data/incoming/a is already in Review as capture cap-old. ' +
                  'Importing it again would make a second copy of the same bag ' +
                  'under a second capture id, with nothing afterwards to tell ' +
                  'them apart.',
              },
            },
            409,
          ),
        );
      }
      return Promise.resolve(jsonResponse({ capture_id: 'cap-b' }, 202));
    }
    return Promise.resolve(jsonResponse({}));
  });

  open();
  await screen.findByTestId('import-list');
  fireEvent.click(screen.getByTestId('import-run'));

  const failed = await screen.findByTestId('import-failed-a');
  expect(failed).toHaveTextContent('already in Review');
  // The actionable half: WHICH capture already holds it.
  expect(failed).toHaveTextContent('cap-old');
});
