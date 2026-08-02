import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';
import { setApiBase } from '../../api/client';
import { makeTestClient, jsonResponse } from '../../test/renderWithClient';
import { setSplitMode } from '../captures/splitMode';
import { useReviewState, ALL_OPERATORS } from './useReviewState';
import type { Capture } from '../../api/types';

function wrapper({ children }: { children: ReactNode }) {
  const client = makeTestClient();
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function capture(partial: Partial<Capture> & { capture_id: string }): Capture {
  return {
    state: 'completed',
    review_status: 'pending',
    review_revision: 0,
    replica: { instance_id: 'inst', state: 'present_verified' },
    digest_state: 'complete',
    ...partial,
  };
}

interface ServerOptions {
  /** capture_id -> the error to answer its review save with. */
  reviewErrors?: Record<string, { status: number; code: string; message: string }>;
  /** capture_id -> the error to answer its delete with. */
  deleteErrors?: Record<
    string,
    { status: number; code: string; message: string; details?: Record<string, unknown> }
  >;
  retention?: unknown;
  transferAvailable?: boolean;
}

/**
 * A stateful fake orchestrator: the capture list reflects saves and deletes, so
 * the hook is exercised end-to-end rather than against a frozen snapshot.
 */
function mockServer(initial: Capture[], options: ServerOptions = {}) {
  let items = initial.map((c) => ({ ...c }));
  const reviewCalls: { captureId: string; body: Record<string, unknown> }[] = [];
  const deleteCalls: { captureId: string; body: Record<string, unknown> }[] = [];
  const pullCalls: string[] = [];

  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {};

    const review = url.match(/\/captures\/([^/?]+)\/review/);
    if (method === 'PATCH' && review) {
      const id = decodeURIComponent(review[1]!);
      reviewCalls.push({ captureId: id, body });
      const err = options.reviewErrors?.[id];
      if (err) {
        return Promise.resolve(
          jsonResponse({ error: { code: err.code, message: err.message } }, err.status),
        );
      }
      const idx = items.findIndex((c) => c.capture_id === id);
      if (idx < 0) return Promise.resolve(jsonResponse({}, 404));
      const next = {
        ...items[idx]!,
        ...(body.review_status ? { review_status: body.review_status } : {}),
        ...(body.quality ? { quality: body.quality } : {}),
        ...(body.task_result ? { task_result: body.task_result } : {}),
        review_revision: (items[idx]!.review_revision ?? 0) + 1,
      } as Capture;
      items[idx] = next;
      return Promise.resolve(jsonResponse(next));
    }

    const del = url.match(/\/captures\/([^/?]+)\/delete/);
    if (method === 'POST' && del) {
      const id = decodeURIComponent(del[1]!);
      deleteCalls.push({ captureId: id, body });
      const err = options.deleteErrors?.[id];
      if (err) {
        return Promise.resolve(
          jsonResponse(
            { error: { code: err.code, message: err.message, details: err.details } },
            err.status,
          ),
        );
      }
      items = items.filter((c) => c.capture_id !== id);
      return Promise.resolve(jsonResponse({}, 200));
    }

    const detail = url.match(/\/captures\/([^/?]+)$/);
    if (method === 'GET' && detail) {
      const id = decodeURIComponent(detail[1]!);
      const found = items.find((c) => c.capture_id === id);
      return Promise.resolve(found ? jsonResponse(found) : jsonResponse({}, 404));
    }

    if (url.includes('/transfer/pull')) {
      pullCalls.push(String(body.capture_id));
      return Promise.resolve(jsonResponse({ queued: true }, 202));
    }
    if (url.includes('/transfer/status'))
      return Promise.resolve(
        jsonResponse({ available: options.transferAvailable ?? false }),
      );
    if (url.includes('/retention'))
      return Promise.resolve(
        jsonResponse(options.retention ?? { days: 0, candidates: [], total_bytes: 0 }),
      );
    if (url.includes('/batches')) return Promise.resolve(jsonResponse({ items: [] }));
    if (url.includes('/captures'))
      return Promise.resolve(jsonResponse({ items: [...items], next_cursor: null }));
    return Promise.resolve(jsonResponse({}));
  });

  return { reviewCalls, deleteCalls, pullCalls, items: () => items };
}

async function renderReview() {
  const view = renderHook(() => useReviewState(), { wrapper });
  await waitFor(() => expect(view.result.current.isLoading).toBe(false));
  return view;
}

beforeEach(() => {
  setApiBase('/api/v1');
  setSplitMode(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

test('captures load into rows keyed by capture_id', async () => {
  mockServer([
    capture({ capture_id: 'c1', run_id: 'run_1', operator: 'ana' }),
    capture({ capture_id: 'c2', run_id: 'run_2', operator: 'bo' }),
  ]);
  const { result } = await renderReview();
  expect(result.current.rows.map((r) => r.captureId).sort()).toEqual(['c1', 'c2']);
  expect(result.current.operatorOptions).toEqual(['ana', 'bo']);
});

test('a quality edit sends base_revision and lands', async () => {
  const server = mockServer([capture({ capture_id: 'c1', review_revision: 2 })]);
  const { result } = await renderReview();
  act(() => result.current.select('c1'));
  await act(async () => result.current.cycleFinalQuality());

  expect(server.reviewCalls).toHaveLength(1);
  // The CAS token is the capture's CURRENT revision — the whole point of §4.1.
  expect(server.reviewCalls[0]!.body).toMatchObject({
    base_revision: 2,
    quality: 'good',
    quality_source: 'operator',
  });
  await waitFor(() =>
    expect(result.current.rows.find((r) => r.captureId === 'c1')!.reviewRevision).toBe(3),
  );
});

test('a 409 review_conflict raises the reload banner and reverts the optimistic value', async () => {
  const server = mockServer(
    [capture({ capture_id: 'c1', quality: 'needs_review', review_revision: 1 })],
    {
      reviewErrors: {
        c1: { status: 409, code: 'review_conflict', message: 'edited elsewhere' },
      },
    },
  );
  const { result } = await renderReview();
  act(() => result.current.select('c1'));
  await act(async () => result.current.cycleFinalQuality());

  await waitFor(() => expect(result.current.reviewSave.conflict).not.toBeNull());
  expect(result.current.reviewSave.conflict!.captureId).toBe('c1');
  expect(result.current.reviewSave.conflict!.reading.code).toBe('review_conflict');
  // Refetched, so the banner can state what is actually stored now.
  expect(result.current.reviewSave.conflict!.current?.quality).toBe('needs_review');
  // The refused value is gone from the row: the screen never keeps showing
  // something the server rejected.
  expect(result.current.rows.find((r) => r.captureId === 'c1')!.effectiveQuality).toBe(
    'Needs review',
  );
  // A conflict is never retried behind the operator's back.
  expect(server.reviewCalls).toHaveLength(1);
});

test('a 500 sidecar write failure surfaces as an explicit failure, not a conflict', async () => {
  mockServer([capture({ capture_id: 'c1' })], {
    reviewErrors: {
      c1: {
        status: 500,
        code: 'review_sidecar_write_failed',
        message: 'could not write record.json',
      },
    },
  });
  const { result } = await renderReview();
  act(() => result.current.select('c1'));
  await act(async () => result.current.markOk());

  await waitFor(() => expect(result.current.reviewSave.failure).not.toBeNull());
  const failure = result.current.reviewSave.failure!;
  expect(failure.code).toBe('review_sidecar_write_failed');
  // §12: this one must be loud. It is the case where the operator would
  // otherwise walk away believing a label exists that does not.
  expect(failure.severity).toBe('destructive');
  expect(failure.guidance).toContain('NOTHING was saved');
  expect(result.current.reviewSave.conflict).toBeNull();
  expect(result.current.rows.find((r) => r.captureId === 'c1')!.reviewStatus).toBe(
    'pending',
  );
});

test('capture_deleting is a reload case: the delete won', async () => {
  mockServer([capture({ capture_id: 'c1' })], {
    reviewErrors: {
      c1: { status: 409, code: 'capture_deleting', message: 'being discarded' },
    },
  });
  const { result } = await renderReview();
  act(() => result.current.select('c1'));
  await act(async () => result.current.markOk());
  await waitFor(() => expect(result.current.reviewSave.conflict).not.toBeNull());
  expect(result.current.reviewSave.conflict!.reading.code).toBe('capture_deleting');
});

test('excluding saves review_status excluded and moves the row out of the default view', async () => {
  const server = mockServer([capture({ capture_id: 'c1' })]);
  const { result } = await renderReview();

  act(() => result.current.requestExclude('c1'));
  // The confirmation opens for a capture with NO index_in_batch too — gating it
  // on the episode number left exactly those captures impossible to exclude.
  expect(result.current.excludePending).toBe(true);
  expect(result.current.pendingExcludeLabel).toBe('—');
  await act(async () => result.current.confirmExclude());

  await waitFor(() => expect(server.reviewCalls).toHaveLength(1));
  expect(server.reviewCalls[0]!.body).toMatchObject({
    review_status: 'excluded',
    quality: 'not_usable',
    quality_source: 'operator',
  });
  await waitFor(() => expect(result.current.nExcluded).toBe(1));
  expect(result.current.rows).toHaveLength(0);
  act(() => result.current.toggleExcluded());
  expect(result.current.rows).toHaveLength(1);
});

test('excluding is reversible — restoring sends review_status pending and removes nothing', async () => {
  const server = mockServer([
    capture({ capture_id: 'c1', review_status: 'excluded', review_revision: 1 }),
  ]);
  const { result } = await renderReview();
  await waitFor(() => expect(result.current.nExcluded).toBe(1));

  await act(async () => result.current.requestExclude('c1'));
  await waitFor(() => expect(server.reviewCalls).toHaveLength(1));
  expect(server.reviewCalls[0]!.body).toMatchObject({ review_status: 'pending' });
  // Exclusion is a label, not a deletion.
  expect(server.deleteCalls).toHaveLength(0);
});

test('discard and delete are separate intents reaching the endpoint with different kinds', async () => {
  const server = mockServer([
    capture({ capture_id: 'c1', review_status: 'excluded', bytes: 1_000 }),
  ]);
  const { result } = await renderReview();

  act(() => result.current.requestDiscard(['c1']));
  expect(result.current.deletion.kind).toBe('discard');
  expect(result.current.deletion.targets.map((c) => c.capture_id)).toEqual(['c1']);
  await act(async () => result.current.deletion.confirm('unusable takes'));
  expect(server.deleteCalls[0]!.body).toEqual({
    kind: 'discard',
    reason: 'unusable takes',
  });
});

test('a delete carries kind delete and tolerates an empty reason', async () => {
  const server = mockServer([capture({ capture_id: 'c1', review_status: 'excluded' })]);
  const { result } = await renderReview();

  act(() => result.current.requestDelete(['c1']));
  expect(result.current.deletion.kind).toBe('delete');
  await act(async () => result.current.deletion.confirm(''));
  expect(server.deleteCalls[0]!.body).toEqual({ kind: 'delete', reason: null });
});

test('a 409 capture_busy is reported by naming the job that holds the lease', async () => {
  mockServer([capture({ capture_id: 'c1', review_status: 'excluded' })], {
    deleteErrors: {
      c1: {
        status: 409,
        code: 'capture_busy',
        message: 'digest is working on c1',
        details: {
          lease_owner: 'digest-job-7',
          lease_expires_at: '2026-08-02T10:00:00Z',
        },
      },
    },
  });
  const { result } = await renderReview();
  act(() => result.current.requestDiscard(['c1']));
  await act(async () => result.current.deletion.confirm('no longer needed'));

  await waitFor(() => expect(result.current.deletion.failures).toHaveLength(1));
  // "try again later" is useless without saying what to wait for (§7.1).
  expect(result.current.deletion.failures[0]!.error).toContain('digest-job-7');
  // The dialog stays open so the failure remains readable.
  expect(result.current.deletion.kind).toBe('discard');
});

test('a bulk removal reports each failure by id and keeps going', async () => {
  const server = mockServer(
    [
      capture({ capture_id: 'c1', review_status: 'excluded' }),
      capture({ capture_id: 'c2', review_status: 'excluded' }),
      capture({ capture_id: 'c3', review_status: 'excluded' }),
    ],
    {
      deleteErrors: {
        c2: { status: 400, code: 'capture_in_dataset', message: 'in 1 dataset(s)' },
      },
    },
  );
  const { result } = await renderReview();
  await waitFor(() => expect(result.current.nExcluded).toBe(3));

  act(() => result.current.requestDelete(['c1', 'c2', 'c3']));
  await act(async () => result.current.deletion.confirm(''));

  // A capture that could not be removed is still there — dropping it from the
  // report is how an operator ends up believing the disk is emptier than it is.
  expect(server.deleteCalls.map((c) => c.captureId)).toEqual(['c1', 'c2', 'c3']);
  expect(result.current.deletion.failures.map((f) => f.captureId)).toEqual(['c2']);
  expect(result.current.deletion.failures[0]!.error).toContain('dataset');
  expect(result.current.deletion.done).toBe(3);
});

test('the retention banner is advisory: it filters and never deletes', async () => {
  const server = mockServer([capture({ capture_id: 'c1' }), capture({ capture_id: 'c2' })], {
    retention: {
      days: 30,
      candidates: [{ capture_id: 'c1', state: 'completed', review_status: 'pending' }],
      total_bytes: 2_048,
    },
  });
  const { result } = await renderReview();
  await waitFor(() => expect(result.current.showRetentionBanner).toBe(true));
  expect(result.current.retentionCandidateCount).toBe(1);

  act(() => result.current.applyRetentionFilter());
  await waitFor(() =>
    expect(result.current.rows.map((r) => r.captureId)).toEqual(['c1']),
  );
  act(() => result.current.clearRetentionFilter());
  expect(result.current.rows).toHaveLength(2);
  expect(server.deleteCalls).toHaveLength(0);
});

test('split mode offers a pull only for a capture with no replica at all', async () => {
  const server = mockServer(
    [
      capture({ capture_id: 'c1', replica: null }),
      capture({
        capture_id: 'c2',
        replica: { instance_id: 'i', state: 'missing_unmanaged' },
      }),
    ],
    { transferAvailable: true },
  );
  const { result } = await renderReview();
  await waitFor(() => expect(result.current.splitMode).toBe(true));

  // c2's copy vanished behind our back (§9-2); pulling is not the answer, so it
  // is not counted as awaiting.
  expect(result.current.nAwaiting).toBe(1);
  act(() => result.current.transferAllAwaiting());
  await waitFor(() => expect(server.pullCalls).toEqual(['c1']));
});

test('search finds a row by capture_id as well as by run_id', async () => {
  mockServer([
    capture({ capture_id: 'cap-abc', run_id: 'run_1' }),
    capture({ capture_id: 'cap-xyz', run_id: 'run_2' }),
  ]);
  const { result } = await renderReview();

  act(() => result.current.setSearch('cap-abc'));
  await waitFor(() =>
    expect(result.current.rows.map((r) => r.captureId)).toEqual(['cap-abc']),
  );
  act(() => result.current.setSearch('run_2'));
  await waitFor(() =>
    expect(result.current.rows.map((r) => r.captureId)).toEqual(['cap-xyz']),
  );
  act(() => result.current.clearFilters());
  expect(result.current.rows).toHaveLength(2);
  expect(result.current.operatorFilter).toBe(ALL_OPERATORS);
});
