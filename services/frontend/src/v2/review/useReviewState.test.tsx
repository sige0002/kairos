import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';
import { setApiBase } from '../../api/client';
import { makeTestClient, jsonResponse } from '../../test/renderWithClient';
import { useUiStore } from '../../store/uiStore';
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

beforeEach(() => {
  setApiBase('/api/v1');
  useUiStore.setState({ activeTab: '', pendingRun: null });
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
