import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import type { StoreHealth } from '../../api/types';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { StoreHealthCard } from './StoreHealthCard';

const OK: StoreHealth = {
  instance_id: 'pc-01',
  state: 'ok',
  delete_available: true,
  rebuilt_at: '2026-08-01T09:00:00Z',
  rebuild_summary: {
    trigger: 'startup',
    at: '2026-08-01T09:00:00Z',
    captures: 128,
    replicas: 128,
    deferred: [],
    corrupt_count: 0,
    warning_count: 0,
  },
  corrupt: [],
  corrupt_source: 'rebuild',
  corrupt_observed_at: '2026-08-01T09:00:00Z',
  warnings: [],
  last_reconcile_at: '2026-08-01T09:05:00Z',
  last_reconcile: {
    applied: true,
    adopted: 0,
    missing: 0,
    reaped: 0,
    corrupt_count: 0,
    threshold: 12,
    denominator: 128,
  },
};

const SUSPECT: StoreHealth = {
  ...OK,
  state: 'suspect',
  suspect_reason: '31 replicas vanished in one pass (threshold 12 of 128)',
  suspect_at: '2026-08-02T11:00:00Z',
  last_reconcile: { ...OK.last_reconcile, applied: false, missing: 31 },
};

/** A 409 in the shared error envelope, as the orchestrator sends it. */
function apiErrorResponse(code: string, message: string, status = 409) {
  return jsonResponse({ error: { code, message } }, status);
}

/** GET /store/health answers from `health`; POST /store/repair from `repair`. */
function mockStore(health: StoreHealth, repair?: () => Response) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = (init as RequestInit)?.method ?? 'GET';
    if (url.includes('/store/repair') && method === 'POST') {
      return Promise.resolve(repair ? repair() : jsonResponse({ repaired: true }));
    }
    if (url.includes('/store/health')) return Promise.resolve(jsonResponse(health));
    return Promise.resolve(jsonResponse({}));
  });
}

beforeEach(() => setApiBase('/api/v1'));
afterEach(() => vi.restoreAllMocks());

test('ok state: reports the rebuild summary and offers no repair to make', async () => {
  mockStore(OK);
  renderWithClient(<StoreHealthCard />);

  await waitFor(() => expect(screen.getByTestId('store-health-state')).toHaveTextContent('ok'));
  expect(screen.getByTestId('store-health-panel')).toHaveTextContent('pc-01');
  // The rebuild figures are the server's own keys, shown verbatim.
  expect(screen.getByTestId('store-health-rebuild')).toHaveTextContent('captures');
  expect(screen.getByTestId('store-health-rebuild')).toHaveTextContent('128');
  // Nothing to acknowledge → the button is disabled and says why.
  expect(screen.getByTestId('store-health-repair')).toBeDisabled();
  expect(screen.getByTestId('store-health-repair-idle')).toHaveTextContent(
    'not in SUSPECT',
  );
  expect(screen.queryByTestId('store-health-suspect')).not.toBeInTheDocument();
});

test('suspect: states the reason, what it stops, what it does not, and repairs', async () => {
  const fetchSpy = mockStore(SUSPECT);
  renderWithClient(<StoreHealthCard />);

  const suspect = await screen.findByTestId('store-health-suspect');
  expect(screen.getByTestId('store-health-state')).toHaveTextContent('suspect');
  expect(suspect).toHaveTextContent('31 replicas vanished in one pass');
  // §9-3: the three things SUSPECT halts...
  expect(suspect).toHaveTextContent(/missing-transitions/i);
  expect(suspect).toHaveTextContent(/reaper/i);
  expect(suspect).toHaveTextContent(/digests/i);
  // ...and the three it deliberately does not.
  expect(suspect).toHaveTextContent(/start and stop still work/i);
  expect(suspect).toHaveTextContent(/review saves/i);
  expect(suspect).toHaveTextContent(/browsing/i);

  const repair = screen.getByTestId('store-health-repair');
  expect(repair).toBeEnabled();
  fireEvent.click(repair);

  await waitFor(() =>
    expect(screen.getByTestId('store-health-repair-result')).toHaveTextContent(
      'SUSPECT cleared',
    ),
  );
  const posts = fetchSpy.mock.calls.filter(
    (c) => String(c[0]).includes('/store/repair') && (c[1] as RequestInit)?.method === 'POST',
  );
  expect(posts).toHaveLength(1);
});

test('a 409 volume_unidentified explains itself and keeps Repair disabled', async () => {
  mockStore(SUSPECT, () =>
    apiErrorResponse(
      'volume_unidentified',
      'The data volume has no readable marker, so it cannot be confirmed as the one the catalog describes.',
    ),
  );
  renderWithClient(<StoreHealthCard />);

  fireEvent.click(await screen.findByTestId('store-health-repair'));

  const error = await screen.findByTestId('store-health-repair-error');
  // Not a generic failure: the code's own operator guidance (errors.ts) is shown.
  expect(error).toHaveAttribute('data-error-code', 'volume_unidentified');
  expect(error).toHaveTextContent('no readable marker');
  expect(error).toHaveTextContent(/Check that the storage is mounted/i);
  // Repair cannot succeed until the volume is identifiable, so it stops being
  // offered — and the explanation stays on screen next to it.
  expect(screen.getByTestId('store-health-repair')).toBeDisabled();
  expect(screen.getByTestId('store-health-repair-error')).toBeInTheDocument();
});

test('re-checking the storage clears the block so Repair can be tried again', async () => {
  mockStore(SUSPECT, () => apiErrorResponse('volume_unidentified', 'no marker'));
  renderWithClient(<StoreHealthCard />);

  fireEvent.click(await screen.findByTestId('store-health-repair'));
  await screen.findByTestId('store-health-repair-error');

  fireEvent.click(screen.getByTestId('store-health-refresh'));

  await waitFor(() =>
    expect(screen.queryByTestId('store-health-repair-error')).not.toBeInTheDocument(),
  );
  await waitFor(() => expect(screen.getByTestId('store-health-repair')).toBeEnabled());
});

test('corrupt sidecars are listed with path and reason (they have no capture row)', async () => {
  mockStore({
    ...OK,
    corrupt: [
      {
        capture_id: '0199aaaa-0000-7000-8000-000000000009',
        path: 'objects/0199aaaa-0000-7000-8000-000000000009/object_manifest.json',
        reason: 'json decode error: Expecting value: line 1 column 1 (char 0)',
      },
      { path: 'objects/broken/object_manifest.json', reason: '0-byte manifest' },
    ],
    rebuild_summary: { ...OK.rebuild_summary, corrupt_count: 2 },
  });
  renderWithClient(<StoreHealthCard />);

  const rows = await screen.findAllByTestId('store-health-corrupt-row');
  expect(rows).toHaveLength(2);
  expect(rows[0]).toHaveTextContent(
    'objects/0199aaaa-0000-7000-8000-000000000009/object_manifest.json',
  );
  expect(rows[0]).toHaveTextContent('json decode error');
  expect(rows[1]).toHaveTextContent('0-byte manifest');
  expect(screen.getByTestId('store-health-corrupt')).toHaveTextContent(
    'no row in the capture list',
  );
  expect(screen.queryByTestId('store-health-corrupt-empty')).not.toBeInTheDocument();
});

// The reconciler now reports the same complete corrupt observation the rebuild
// does, and says which pass produced it — so a reconciler-found sidecar shows
// its path here rather than only a count.
test('a reconciler-found corrupt sidecar shows its path and names the pass', async () => {
  mockStore({
    ...OK,
    corrupt: [{ capture_id: 'c9', path: 'objects/c9/object_manifest.json', reason: 'unparseable' }],
    corrupt_source: 'reconcile',
    corrupt_observed_at: '2026-08-01T09:05:00Z',
  });
  renderWithClient(<StoreHealthCard />);

  const list = await screen.findByTestId('store-health-corrupt-list');
  expect(list).toHaveTextContent('objects/c9/object_manifest.json');
  expect(list).toHaveTextContent('unparseable');
  expect(screen.getByTestId('store-health-corrupt-observed')).toHaveTextContent(
    'reconciler pass',
  );
});

// "No corruption" is only meaningful with a timestamp: the same answer from a
// scan seconds ago and one taken at boot three days ago read identically
// without it.
test('an all-clear names the pass that looked and when', async () => {
  mockStore({
    ...OK,
    corrupt: [],
    corrupt_source: 'reconcile',
    corrupt_observed_at: '2026-08-01T09:05:00Z',
  });
  renderWithClient(<StoreHealthCard />);

  await waitFor(() =>
    expect(screen.getByTestId('store-health-corrupt-empty')).toHaveTextContent(
      'reconciler pass',
    ),
  );
});

// A reconciler observation counts as a scan: treating only a rebuild as real
// would report a fresh reconciler all-clear as "nothing has been read".
test('a reconciler observation alone still counts as having looked', async () => {
  mockStore({
    ...OK,
    rebuilt_at: null,
    rebuild_summary: null,
    corrupt: [],
    corrupt_source: 'reconcile',
    corrupt_observed_at: '2026-08-01T09:05:00Z',
  });
  renderWithClient(<StoreHealthCard />);

  await waitFor(() =>
    expect(screen.getByTestId('store-health-corrupt-empty')).not.toHaveTextContent(
      'No scan has completed',
    ),
  );
});

// With nothing having scanned at all, silence is NOT an all-clear.
test('no completed scan is stated as such, never as clean', async () => {
  mockStore({
    ...OK,
    rebuilt_at: null,
    rebuild_summary: null,
    corrupt: [],
    corrupt_source: null,
    corrupt_observed_at: null,
  });
  renderWithClient(<StoreHealthCard />);

  await waitFor(() =>
    expect(screen.getByTestId('store-health-corrupt-empty')).toHaveTextContent(
      'That is not an all-clear',
    ),
  );
});

test('delete_available false explains the one-filesystem rule and why it is deliberate', async () => {
  mockStore({
    ...OK,
    delete_available: false,
    delete_unavailable_reason: '.trash is on a different device than objects',
  });
  renderWithClient(<StoreHealthCard />);

  const del = await screen.findByTestId('store-health-delete');
  expect(del).toHaveTextContent('deletion switched off');
  expect(del).toHaveTextContent('.trash/');
  expect(del).toHaveTextContent('.incoming/');
  expect(del).toHaveTextContent(/not on\s+one filesystem/i);
  expect(del).toHaveTextContent(/EXDEV copy is not the atomic move/i);
  expect(del).toHaveTextContent('.trash is on a different device than objects');
});

test('warnings from the last rebuild are listed', async () => {
  mockStore({ ...OK, warnings: ['record.json newer than the manifest for 2 captures'] });
  renderWithClient(<StoreHealthCard />);

  await waitFor(() =>
    expect(screen.getByTestId('store-health-warnings')).toHaveTextContent(
      'record.json newer than the manifest',
    ),
  );
});

test('an unreadable health endpoint is never rendered as ok', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
    Promise.resolve(apiErrorResponse('internal_error', 'boom', 500)),
  );
  renderWithClient(<StoreHealthCard />);

  await waitFor(() =>
    expect(screen.getByTestId('store-health-panel')).toHaveTextContent(
      'this is not an all-clear',
    ),
  );
  expect(screen.getByTestId('store-health-state')).toHaveTextContent('not reported');
  expect(screen.getByRole('alert')).toHaveTextContent('boom');
});
