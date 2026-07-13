import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';
import { setApiBase } from '../../api/client';
import { makeTestClient, jsonResponse } from '../../test/renderWithClient';
import { useUiStore } from '../../store/uiStore';
import { __clearEpisodeOutcomes, saveEpisodeOutcome } from '../episodeBridge';
import { useReviewState, ALL_OPERATORS } from './useReviewState';

function wrapper({ children }: { children: ReactNode }) {
  const client = makeTestClient();
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function mockRuns(items: Record<string, unknown>[]) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/runs')) return Promise.resolve(jsonResponse({ items, next_cursor: null }));
    return Promise.resolve(jsonResponse({}));
  });
}

// A stateful mock: GET /runs returns the live list; DELETE /runs/{id} removes it
// (unless its id is in `failIds`, where it 500s and stays). Lets the delete
// flows be exercised without touching a real backend.
function mockRunsMutable(initial: Record<string, unknown>[], failIds: string[] = []) {
  let items = [...initial];
  const deleteCalls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const detail = url.match(/\/runs\/([^/?]+)/);
    if (method === 'DELETE' && detail) {
      const id = decodeURIComponent(detail[1]!);
      deleteCalls.push(id);
      if (failIds.includes(id))
        return Promise.resolve(jsonResponse({ error: { code: 'io', message: 'disk busy' } }, 500));
      items = items.filter((r) => r.run_id !== id);
      return Promise.resolve(jsonResponse({}, 200));
    }
    if (url.includes('/runs')) return Promise.resolve(jsonResponse({ items: [...items], next_cursor: null }));
    return Promise.resolve(jsonResponse({}));
  });
  return { deleteCalls };
}

async function excludeAll(result: { current: ReturnType<typeof useReviewState> }, runIds: string[]) {
  for (const id of runIds) {
    act(() => result.current.requestArchive(id));
    act(() => result.current.confirmArchive());
  }
}

beforeEach(() => {
  setApiBase('/api/v1');
  useUiStore.setState({ activeTab: '', pendingRun: null });
  // mapRuns now reads the Collect->Review bridge (localStorage); clear it so
  // one test's seeded outcome can't bleed into another.
  __clearEpisodeOutcomes();
});
afterEach(() => vi.restoreAllMocks());

test('maps real /runs into rows and excludes runs that never finished', async () => {
  mockRuns([
    { run_id: 'a', state: 'created', started_at: '2026-07-13T09:00:00Z' },
    { run_id: 'b', state: 'completed', started_at: '2026-07-13T09:05:00Z' },
  ]);
  const { result } = renderHook(() => useReviewState(), { wrapper });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  expect(result.current.isError).toBe(false);
  expect(result.current.rows).toHaveLength(1);
  expect(result.current.rows[0]?.runId).toBe('b');
});

test('a failed /runs request yields an honest empty+error state, never fabricated rows', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.reject(new Error('down')));
  const { result } = renderHook(() => useReviewState(), { wrapper });
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.rows).toHaveLength(0);
});

test('a completed run starts with unset (null) quality/task — no synthetic label', async () => {
  mockRuns([{ run_id: 'a', state: 'completed', started_at: '2026-07-13T09:00:00Z' }]);
  const { result } = renderHook(() => useReviewState(), { wrapper });
  await waitFor(() => expect(result.current.rows).toHaveLength(1));
  expect(result.current.rows[0]?.effectiveQuality).toBeNull();
  expect(result.current.rows[0]?.effectiveTask).toBeNull();
});

test('a bridged Collect outcome surfaces as the effective quality/task/batch', async () => {
  saveEpisodeOutcome('a', {
    quality: 'review',
    taskResult: 'fail',
    failReason: 'Grasp missed',
    batchNum: 2,
    episodeIndex: 5,
    savedAt: 1,
  });
  mockRuns([{ run_id: 'a', state: 'completed', started_at: '2026-07-13T09:00:00Z' }]);
  const { result } = renderHook(() => useReviewState(), { wrapper });
  await waitFor(() => expect(result.current.rows).toHaveLength(1));
  const row = result.current.rows[0]!;
  expect(row.effectiveQuality).toBe('Needs review');
  expect(row.effectiveTask).toBe('Failure');
  // Batch column is a per-list grouping ordinal (first distinct batch = 1).
  expect(row.batch).toBe('1');
});

test('a session override still wins over the bridged value', async () => {
  saveEpisodeOutcome('a', { quality: 'good', taskResult: 'ok', batchNum: 1, episodeIndex: 1, savedAt: 1 });
  mockRuns([{ run_id: 'a', state: 'completed', started_at: '2026-07-13T09:00:00Z' }]);
  const { result } = renderHook(() => useReviewState(), { wrapper });
  await waitFor(() => expect(result.current.rows).toHaveLength(1));
  // Bridge seeds 'Good'; one cycle moves it to the operator's own 'Needs review'.
  expect(result.current.rows[0]?.effectiveQuality).toBe('Good');
  act(() => result.current.select('a'));
  act(() => result.current.cycleFinalQuality());
  expect(result.current.selected!.effectiveQuality).toBe('Needs review');
});

test('cycleFinalQuality: first click sets Good, then wraps Good->Needs review->Not usable->Good', async () => {
  mockRuns([{ run_id: 'a', state: 'completed', started_at: '2026-07-13T09:00:00Z' }]);
  const { result } = renderHook(() => useReviewState(), { wrapper });
  await waitFor(() => expect(result.current.rows).toHaveLength(1));
  act(() => result.current.select(result.current.rows[0]!.runId));

  // From the unset "—" base, the first click lands on the first real value.
  act(() => result.current.cycleFinalQuality());
  expect(result.current.selected!.effectiveQuality).toBe('Good');
  act(() => result.current.cycleFinalQuality());
  expect(result.current.selected!.effectiveQuality).toBe('Needs review');
  act(() => result.current.cycleFinalQuality());
  expect(result.current.selected!.effectiveQuality).toBe('Not usable');
  act(() => result.current.cycleFinalQuality());
  expect(result.current.selected!.effectiveQuality).toBe('Good');
});

test('cycleTaskResult: first click sets Success, then toggles', async () => {
  mockRuns([{ run_id: 'a', state: 'completed', started_at: '2026-07-13T09:00:00Z' }]);
  const { result } = renderHook(() => useReviewState(), { wrapper });
  await waitFor(() => expect(result.current.rows).toHaveLength(1));
  act(() => result.current.select(result.current.rows[0]!.runId));
  act(() => result.current.cycleTaskResult());
  expect(result.current.selected!.effectiveTask).toBe('Success');
  act(() => result.current.cycleTaskResult());
  expect(result.current.selected!.effectiveTask).toBe('Failure');
});

test('overrides are counted per run as real session history', async () => {
  mockRuns([{ run_id: 'a', state: 'completed', started_at: '2026-07-13T09:00:00Z' }]);
  const { result } = renderHook(() => useReviewState(), { wrapper });
  await waitFor(() => expect(result.current.rows).toHaveLength(1));
  act(() => result.current.select(result.current.rows[0]!.runId));
  expect(result.current.selectedOverrideCount).toBe(0);
  act(() => result.current.cycleFinalQuality());
  act(() => result.current.cycleTaskResult());
  expect(result.current.selectedOverrideCount).toBe(2);
});

test('adoptAllGood only adopts undecided Good episodes; decide() sets a specific decision', async () => {
  // Both runs are `failed`, so mapRuns deterministically starts them at "Not
  // usable" — no dependency on any quality guess.
  mockRuns([
    { run_id: 'ep-a', state: 'failed', started_at: '2026-07-13T09:00:00Z' },
    { run_id: 'ep-b', state: 'failed', started_at: '2026-07-13T09:05:00Z' },
  ]);
  const { result } = renderHook(() => useReviewState(), { wrapper });
  await waitFor(() => expect(result.current.rows).toHaveLength(2));

  const [epB, epA] = result.current.rows; // sorted newest (highest ep) first
  expect(epA!.runId).toBe('ep-a');
  expect(epB!.runId).toBe('ep-b');

  // Force ep-a to "Good" (one cycle: Not usable -> Good) so adoptAllGood has
  // something undecided to pick up.
  act(() => result.current.select(epA!.runId));
  act(() => result.current.cycleFinalQuality());
  expect(result.current.selected!.effectiveQuality).toBe('Good');
  expect(result.current.nUndecidedGood).toBe(1);

  act(() => result.current.adoptAllGood());
  const rowA = result.current.rows.find((r) => r.runId === 'ep-a');
  expect(rowA?.decision).toBe('adopted');
  expect(result.current.nUndecidedGood).toBe(0);

  // decide() applies to the currently-selected episode only.
  act(() => result.current.select(epB!.runId));
  act(() => result.current.decide('excluded'));
  const rowB = result.current.rows.find((r) => r.runId === 'ep-b');
  expect(rowB?.decision).toBe('excluded');
  expect(rowA?.runId).not.toBe(rowB?.runId);
});

test('requestArchive opens a pending confirm; confirming reclassifies as Not usable/Excluded/archived', async () => {
  mockRuns([{ run_id: 'ep-a', state: 'completed', started_at: '2026-07-13T09:00:00Z' }]);
  const { result } = renderHook(() => useReviewState(), { wrapper });
  await waitFor(() => expect(result.current.rows).toHaveLength(1));
  const runId = result.current.rows[0]!.runId;
  const ep = result.current.rows[0]!.ep;

  act(() => result.current.requestArchive(runId));
  expect(result.current.pendingArchiveEp).toBe(ep);
  // Not archived yet until confirmed.
  expect(result.current.rows.find((r) => r.runId === runId)?.isArchived).toBe(false);

  act(() => result.current.confirmArchive());
  expect(result.current.pendingArchiveEp).toBeNull();
  // Archived rows drop out of the default (non-"show archived") view.
  expect(result.current.rows.find((r) => r.runId === runId)).toBeUndefined();
  expect(result.current.hasArchived).toBe(true);

  act(() => result.current.toggleArchived());
  const archivedRow = result.current.rows.find((r) => r.runId === runId);
  expect(archivedRow?.isArchived).toBe(true);
  expect(archivedRow?.effectiveQuality).toBe('Not usable');
  expect(archivedRow?.decision).toBe('excluded');

  // Restoring is immediate — no confirm modal.
  act(() => result.current.requestArchive(runId));
  expect(result.current.pendingArchiveEp).toBeNull();
  expect(result.current.rows.find((r) => r.runId === runId)?.isArchived).toBe(false);
});

test(
  'transferOne drives on_robot -> transferring -> transferred over time',
  async () => {
    mockRuns([{ run_id: 'ep-a', state: 'completed', started_at: '2026-07-13T09:00:00Z' }]);
    const { result } = renderHook(() => useReviewState(), { wrapper });
    await waitFor(() => expect(result.current.rows).toHaveLength(1));

    // Every real row seeds on_robot until explicitly transferred.
    const onRobotRow = result.current.rows.find((r) => r.transferSlot.phase === 'on_robot');
    expect(onRobotRow).toBeTruthy();
    const runId = onRobotRow!.runId;

    act(() => result.current.transferOne(runId));
    await waitFor(() => {
      const row = result.current.rows.find((r) => r.runId === runId);
      expect(row?.transferSlot.phase).toBe('transferring');
    });
    await waitFor(
      () => {
        const row = result.current.rows.find((r) => r.runId === runId);
        expect(row?.transferSlot.phase).toBe('transferred');
      },
      { timeout: 4000 },
    );
  },
  8000,
);

test('search filters by episode number or run id', async () => {
  mockRuns([
    { run_id: 'alpha', state: 'completed', started_at: '2026-07-13T09:00:00Z' },
    { run_id: 'beta', state: 'completed', started_at: '2026-07-13T09:05:00Z' },
  ]);
  const { result } = renderHook(() => useReviewState(), { wrapper });
  await waitFor(() => expect(result.current.rows).toHaveLength(2));

  act(() => result.current.setSearch('alpha'));
  expect(result.current.rows.map((r) => r.runId)).toEqual(['alpha']);

  act(() => result.current.clearFilters());
  expect(result.current.rows).toHaveLength(2);
});

test('delete is a real DELETE, drops the run from the list, and clears selection', async () => {
  const { deleteCalls } = mockRunsMutable([
    { run_id: 'a', state: 'completed', started_at: '2026-07-13T09:00:00Z', bytes: 1000 },
    { run_id: 'b', state: 'completed', started_at: '2026-07-13T09:05:00Z', bytes: 2000 },
  ]);
  const { result } = renderHook(() => useReviewState(), { wrapper });
  await waitFor(() => expect(result.current.rows).toHaveLength(2));

  // Delete is only reachable via Exclude first.
  await excludeAll(result, ['a']);
  expect(result.current.excludedRows.map((r) => r.runId)).toEqual(['a']);

  act(() => result.current.requestDelete('a'));
  expect(result.current.pendingDeleteRow?.runId).toBe('a');
  expect(result.current.pendingDeleteRow?.bytes).toBe(1000);

  await act(async () => {
    await result.current.confirmDelete();
  });
  expect(deleteCalls).toEqual(['a']);
  // The list refetches without the deleted run, and nothing stale lingers.
  await waitFor(() => expect(result.current.rows.map((r) => r.runId)).toEqual(['b']));
  expect(result.current.excludedRows).toHaveLength(0);
  expect(result.current.pendingDeleteRow).toBeNull();
});

test('bulk delete removes every excluded run on success', async () => {
  const { deleteCalls } = mockRunsMutable([
    { run_id: 'a', state: 'completed', started_at: '2026-07-13T09:00:00Z', bytes: 1000 },
    { run_id: 'b', state: 'completed', started_at: '2026-07-13T09:05:00Z', bytes: 2000 },
    { run_id: 'c', state: 'completed', started_at: '2026-07-13T09:10:00Z', bytes: 3000 },
  ]);
  const { result } = renderHook(() => useReviewState(), { wrapper });
  await waitFor(() => expect(result.current.rows).toHaveLength(3));

  await excludeAll(result, ['a', 'b']);
  expect(result.current.excludedRows).toHaveLength(2);

  act(() => result.current.requestBulkDelete());
  await act(async () => {
    await result.current.confirmBulkDelete();
  });
  expect(deleteCalls.sort()).toEqual(['a', 'b']);
  expect(result.current.bulkFailures).toHaveLength(0);
  await waitFor(() => expect(result.current.rows.map((r) => r.runId)).toEqual(['c']));
  expect(result.current.excludedRows).toHaveLength(0);
});

test('bulk delete reports per-run failures honestly; a failed run stays excluded', async () => {
  mockRunsMutable(
    [
      { run_id: 'a', state: 'completed', started_at: '2026-07-13T09:00:00Z', bytes: 1000 },
      { run_id: 'b', state: 'completed', started_at: '2026-07-13T09:05:00Z', bytes: 2000 },
    ],
    ['b'], // DELETE b fails
  );
  const { result } = renderHook(() => useReviewState(), { wrapper });
  await waitFor(() => expect(result.current.rows).toHaveLength(2));

  await excludeAll(result, ['a', 'b']);
  act(() => result.current.requestBulkDelete());
  await act(async () => {
    await result.current.confirmBulkDelete();
  });
  expect(result.current.bulkFailures.map((f) => f.runId)).toEqual(['b']);
  // 'a' is gone; 'b' failed, so it remains excluded (not silently dropped).
  await waitFor(() => expect(result.current.excludedRows.map((r) => r.runId)).toEqual(['b']));
  expect(result.current.bulkDeleteOpen).toBe(true); // stays open to show the failure
});

test('operator filter is real: options are the distinct run operators and it filters rows', async () => {
  mockRuns([
    { run_id: 'a', state: 'completed', operator: 'alice', started_at: '2026-07-13T09:00:00Z' },
    { run_id: 'b', state: 'completed', operator: 'bob', started_at: '2026-07-13T09:05:00Z' },
    { run_id: 'c', state: 'completed', operator: 'alice', started_at: '2026-07-13T09:10:00Z' },
  ]);
  const { result } = renderHook(() => useReviewState(), { wrapper });
  await waitFor(() => expect(result.current.rows).toHaveLength(3));
  expect(result.current.operatorOptions).toEqual(['alice', 'bob']);

  act(() => result.current.setOperatorFilter('alice'));
  expect(result.current.rows.map((r) => r.runId).sort()).toEqual(['a', 'c']);

  act(() => result.current.setOperatorFilter(ALL_OPERATORS));
  expect(result.current.rows).toHaveLength(3);
});

// ---- Phase 2: PATCH /episodes on override / adopt-exclude (server-backed) ---

/** A run carrying a server episode, plus a capturing PATCH /episodes handler. */
function mockRunsWithEpisode(
  episode: Record<string, unknown>,
  patchStatus = 200,
): { patchCalls: { url: string; body: Record<string, unknown> | undefined }[] } {
  const patchCalls: { url: string; body: Record<string, unknown> | undefined }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.includes('/episodes/') && method === 'PATCH') {
      let body: Record<string, unknown> | undefined;
      try {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      } catch {
        body = undefined;
      }
      patchCalls.push({ url, body });
      if (patchStatus >= 400) {
        return Promise.resolve(jsonResponse({ error: { code: 'x', message: 'no' } }, patchStatus));
      }
      return Promise.resolve(jsonResponse({ episode_id: 'ep_1', ...body }, 200));
    }
    if (url.includes('/runs')) {
      return Promise.resolve(
        jsonResponse({
          items: [{ run_id: 'a', state: 'completed', started_at: '2026-07-13T09:00:00Z', episode }],
          next_cursor: null,
        }),
      );
    }
    return Promise.resolve(jsonResponse({}));
  });
  return { patchCalls };
}

const EP = {
  episode_id: 'ep_1',
  batch_id: 'b1',
  index_in_batch: 1,
  task_result: 'success',
  quality: 'good',
  review_status: 'pending',
};

test('cycling quality on a server-backed run PATCHes the episode with the mapped enum', async () => {
  const { patchCalls } = mockRunsWithEpisode(EP);
  const { result } = renderHook(() => useReviewState(), { wrapper });
  await waitFor(() => expect(result.current.rows).toHaveLength(1));
  // The server episode surfaces as the effective quality.
  expect(result.current.rows[0]?.effectiveQuality).toBe('Good');

  act(() => result.current.select('a'));
  act(() => result.current.cycleFinalQuality()); // Good -> Needs review

  expect(result.current.selected!.effectiveQuality).toBe('Needs review');
  await waitFor(() => expect(patchCalls).toHaveLength(1));
  expect(patchCalls[0]?.url).toContain('/episodes/ep_1');
  expect(patchCalls[0]?.body).toMatchObject({ quality: 'needs_review', quality_source: 'operator' });
});

test('excluding a server-backed run PATCHes review_status excluded', async () => {
  const { patchCalls } = mockRunsWithEpisode(EP);
  const { result } = renderHook(() => useReviewState(), { wrapper });
  await waitFor(() => expect(result.current.rows).toHaveLength(1));

  act(() => result.current.requestArchive('a'));
  act(() => result.current.confirmArchive());

  await waitFor(() => expect(patchCalls).toHaveLength(1));
  expect(patchCalls[0]?.url).toContain('/episodes/ep_1');
  expect(patchCalls[0]?.body).toMatchObject({ review_status: 'excluded', quality: 'not_usable' });
});

test('a failed PATCH reverts the optimistic quality override', async () => {
  mockRunsWithEpisode(EP, 500);
  const { result } = renderHook(() => useReviewState(), { wrapper });
  await waitFor(() => expect(result.current.rows).toHaveLength(1));

  act(() => result.current.select('a'));
  act(() => result.current.cycleFinalQuality()); // optimistic Good -> Needs review
  // The failed PATCH reverts the override back to the server's Good.
  await waitFor(() => expect(result.current.selected!.effectiveQuality).toBe('Good'));
});

test('a run with no server episode stays local-only (no PATCH is attempted)', async () => {
  // No `episode` on the run → mapRuns yields episodeId null.
  const patchCalls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (url.includes('/episodes/') && (init?.method ?? 'GET') === 'PATCH') patchCalls.push(url);
    if (url.includes('/runs')) {
      return Promise.resolve(
        jsonResponse({
          items: [{ run_id: 'a', state: 'completed', started_at: '2026-07-13T09:00:00Z' }],
          next_cursor: null,
        }),
      );
    }
    return Promise.resolve(jsonResponse({}));
  });
  const { result } = renderHook(() => useReviewState(), { wrapper });
  await waitFor(() => expect(result.current.rows).toHaveLength(1));

  act(() => result.current.select('a'));
  act(() => result.current.cycleFinalQuality());
  // Local override still applies, but nothing is PATCHed to the server.
  expect(result.current.selected!.effectiveQuality).toBe('Good');
  await Promise.resolve();
  expect(patchCalls).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Adopt visibility + export-adopted → Datasets.
// ---------------------------------------------------------------------------

function episode(review_status: string, extra: Record<string, unknown> = {}) {
  return {
    episode_id: `ep_${review_status}`,
    batch_id: 'b1',
    index_in_batch: 1,
    task_result: 'success',
    quality: 'good',
    review_status,
    ...extra,
  };
}

/** Runs with server episodes + a capturing POST /datasets/export handler. */
function mockRunsWithExport(items: Record<string, unknown>[]) {
  const exportCalls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (url.includes('/datasets/export') && (init?.method ?? 'GET') === 'POST') {
      const body = JSON.parse(String(init?.body)) as { run_id: string };
      exportCalls.push(body.run_id);
      return Promise.resolve(jsonResponse({ run_id: body.run_id, index: '001' }));
    }
    if (url.includes('/runs')) {
      return Promise.resolve(jsonResponse({ items, next_cursor: null }));
    }
    return Promise.resolve(jsonResponse({}));
  });
  return { exportCalls };
}

test('effectiveReviewStatus reflects the server review_status (chip source)', async () => {
  mockRunsWithExport([
    { run_id: 'a', state: 'completed', started_at: '2026-07-13T09:00:00Z', episode: episode('adopted') },
    { run_id: 'b', state: 'completed', started_at: '2026-07-13T09:05:00Z', episode: episode('pending') },
  ]);
  const { result } = renderHook(() => useReviewState(), { wrapper });
  await waitFor(() => expect(result.current.rows).toHaveLength(2));
  const byId = (id: string) => result.current.rows.find((r) => r.runId === id)!;
  expect(byId('a').effectiveReviewStatus).toBe('adopted');
  expect(byId('b').effectiveReviewStatus).toBe('pending');
});

test('adopting a run flips its effectiveReviewStatus immediately', async () => {
  mockRunsWithExport([
    { run_id: 'a', state: 'completed', started_at: '2026-07-13T09:00:00Z', episode: episode('pending') },
  ]);
  const { result } = renderHook(() => useReviewState(), { wrapper });
  await waitFor(() => expect(result.current.rows).toHaveLength(1));
  expect(result.current.rows[0]?.effectiveReviewStatus).toBe('pending');

  act(() => result.current.select('a'));
  act(() => result.current.decide('adopted'));
  expect(result.current.rows[0]?.effectiveReviewStatus).toBe('adopted');
});

test('export-adopted separates completed (exportable) from a non-completed adopted run (skipped)', async () => {
  mockRunsWithExport([
    { run_id: 'done', state: 'completed', started_at: '2026-07-13T09:00:00Z', episode: episode('adopted') },
    // A failed run the operator adopts by hand — not exportable.
    { run_id: 'bad', state: 'failed', started_at: '2026-07-13T09:05:00Z' },
  ]);
  const { result } = renderHook(() => useReviewState(), { wrapper });
  await waitFor(() => expect(result.current.rows).toHaveLength(2));

  act(() => result.current.select('bad'));
  act(() => result.current.decide('adopted'));

  expect(result.current.adoptedRows.map((r) => r.runId).sort()).toEqual(['bad', 'done']);
  // Only the completed run is exportable; the failed one is listed as skipped.
  expect(result.current.adoptedExportable.map((r) => r.runId)).toEqual(['done']);
  expect(result.current.adoptedSkipped.map((r) => r.runId)).toEqual(['bad']);
});

test('confirmExportAdopted POSTs completed adopted runs and double-invalidates (runs + datasets)', async () => {
  const { exportCalls } = mockRunsWithExport([
    { run_id: 'a', state: 'completed', started_at: '2026-07-13T09:00:00Z', episode: episode('adopted') },
  ]);
  const invalidate = vi.spyOn(QueryClient.prototype, 'invalidateQueries');
  const { result } = renderHook(() => useReviewState(), { wrapper });
  await waitFor(() => expect(result.current.adoptedExportable).toHaveLength(1));

  act(() => result.current.requestExportAdopted());
  await act(async () => {
    await result.current.confirmExportAdopted();
  });

  expect(exportCalls).toEqual(['a']);
  expect(result.current.exportFailures).toHaveLength(0);
  // MOVE semantics: invalidates the runs list AND the datasets list.
  const keys = invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
  expect(keys).toContain(JSON.stringify(['runs', null]));
  expect(keys).toContain(JSON.stringify(['datasets']));
});

test('a failed export keeps the run in Review with an honest per-run note', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (url.includes('/datasets/export') && (init?.method ?? 'GET') === 'POST') {
      return Promise.resolve(jsonResponse({ error: { code: 'io', message: 'disk full' } }, 500));
    }
    if (url.includes('/runs')) {
      return Promise.resolve(
        jsonResponse({
          items: [
            { run_id: 'a', state: 'completed', started_at: '2026-07-13T09:00:00Z', episode: episode('adopted') },
          ],
          next_cursor: null,
        }),
      );
    }
    return Promise.resolve(jsonResponse({}));
  });
  const { result } = renderHook(() => useReviewState(), { wrapper });
  await waitFor(() => expect(result.current.adoptedExportable).toHaveLength(1));

  act(() => result.current.requestExportAdopted());
  await act(async () => {
    await result.current.confirmExportAdopted();
  });

  expect(result.current.exportFailures.map((f) => f.runId)).toEqual(['a']);
  // The dialog stays open so the failure is visible; the run is still adopted.
  expect(result.current.exportAdoptedOpen).toBe(true);
  expect(result.current.adoptedRows).toHaveLength(1);
});
