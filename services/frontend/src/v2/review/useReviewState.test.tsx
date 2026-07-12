import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';
import { setApiBase } from '../../api/client';
import { makeTestClient, jsonResponse } from '../../test/renderWithClient';
import { useUiStore } from '../../store/uiStore';
import { useReviewState } from './useReviewState';

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
  expect(result.current.usingFallback).toBe(false);
  expect(result.current.rows).toHaveLength(1);
  expect(result.current.rows[0]?.runId).toBe('b');
});

test('falls back to the built-in demo set when /runs is unreachable', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.reject(new Error('down')));
  const { result } = renderHook(() => useReviewState(), { wrapper });
  await waitFor(() => expect(result.current.usingFallback).toBe(true));
  expect(result.current.rows.length).toBeGreaterThan(0);
});

test('cycleFinalQuality rotates Good -> Needs review -> Not usable and wraps after 3 steps', async () => {
  mockRuns([{ run_id: 'a', state: 'completed', started_at: '2026-07-13T09:00:00Z' }]);
  const { result } = renderHook(() => useReviewState(), { wrapper });
  await waitFor(() => expect(result.current.rows).toHaveLength(1));
  act(() => result.current.select(result.current.rows[0]!.runId));

  const order = ['Good', 'Needs review', 'Not usable'];
  const start = result.current.selected!.effectiveQuality;
  act(() => result.current.cycleFinalQuality());
  expect(result.current.selected!.effectiveQuality).toBe(order[(order.indexOf(start) + 1) % 3]);
  act(() => result.current.cycleFinalQuality());
  act(() => result.current.cycleFinalQuality());
  // A full 3-step loop returns to the starting value.
  expect(result.current.selected!.effectiveQuality).toBe(start);
});

test('cycleTaskResult toggles Success <-> Failure', async () => {
  mockRuns([{ run_id: 'a', state: 'completed', started_at: '2026-07-13T09:00:00Z' }]);
  const { result } = renderHook(() => useReviewState(), { wrapper });
  await waitFor(() => expect(result.current.rows).toHaveLength(1));
  act(() => result.current.select(result.current.rows[0]!.runId));
  const start = result.current.selected!.effectiveTask;
  act(() => result.current.cycleTaskResult());
  expect(result.current.selected!.effectiveTask).not.toBe(start);
  act(() => result.current.cycleTaskResult());
  expect(result.current.selected!.effectiveTask).toBe(start);
});

test('adoptAllGood only adopts undecided Good episodes; decide() sets a specific decision', async () => {
  // Both runs are `failed`, so mapRuns deterministically starts them at "Not
  // usable" — no dependency on the mock quality hash landing on "Good".
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
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.reject(new Error('down')));
    const { result } = renderHook(() => useReviewState(), { wrapper });
    await waitFor(() => expect(result.current.usingFallback).toBe(true));

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
