// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';
import { setApiBase } from '../../api/client';
import { makeTestClient, jsonResponse } from '../../test/renderWithClient';
import { setSplitMode } from '../captures/splitMode';
import { useReviewState, ALL_OPERATORS } from './useReviewState';
import type { CaptureListItem } from '../../api/types';

function wrapper({ children }: { children: ReactNode }) {
  const client = makeTestClient();
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function capture(
  partial: Partial<CaptureListItem> & { capture_id: string },
): CaptureListItem {
  return {
    state: 'completed',
    review_status: 'pending',
    review_revision: 0,
    replica: { instance_id: 'inst', state: 'present_verified' },
    digest_state: 'complete',
    ...partial,
  };
}

function collectionContext(condition: string) {
  return {
    batch_id: null,
    batch_seq: null,
    project_id: null,
    task_id: null,
    condition_id: null,
    project: null,
    task: null,
    condition,
    robot: null,
    operator: null,
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
  /** When true, every capture page reports another page after it, so the
   *  sweep ends at the client's own MAX_PAGES cap — the real truncation path,
   *  not a faked flag. */
  capturesNeverEnd?: boolean;
  /** Hold every review save open. The compare-and-swap is still decided on
   *  ARRIVAL (a real server serialises); only the delivery of the answer waits
   *  for `releaseReviews()`. That wait is the window a second click lands in. */
  holdReviews?: boolean;
}

/**
 * A stateful fake orchestrator: the capture list reflects saves and deletes, so
 * the hook is exercised end-to-end rather than against a frozen snapshot.
 *
 * NOT a compare-and-swap, and the tests below must not be read as if it were.
 * `base_revision` is recorded on the way out and asserted, so what the client
 * SENDS is pinned here — but a 409 is injected through `reviewErrors`, never
 * produced by comparing that revision against a stored one. So these tests fix
 * how the client behaves once a refusal exists, in each delivery order; they
 * are not evidence that the server would refuse. That a stale revision draws a
 * refusal at all is the server's contract, and it is covered where a real
 * second actor exists: `e2e/tests/02-review.spec.ts` (§13-2) saves through the
 * API first and then clicks.
 */
function mockServer(initial: CaptureListItem[], options: ServerOptions = {}) {
  let items = initial.map((c) => ({ ...c }));
  const reviewCalls: { captureId: string; body: Record<string, unknown> }[] = [];
  const deleteCalls: { captureId: string; body: Record<string, unknown> }[] = [];
  const pullCalls: string[] = [];
  const searchCalls: Record<string, unknown>[] = [];
  const heldReviews: (() => void)[] = [];
  // The caller's own object, NOT a copy: tests below mutate the map they passed
  // in to stop refusing partway through a run, and a copy would quietly ignore
  // them. The setters returned at the bottom are the same trick, named.
  const reviewErrors = options.reviewErrors ?? {};
  const answer = (r: Response) =>
    options.holdReviews
      ? new Promise<Response>((resolve) => heldReviews.push(() => resolve(r)))
      : Promise.resolve(r);

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
      const err = reviewErrors[id];
      if (err) {
        return answer(
          jsonResponse({ error: { code: err.code, message: err.message } }, err.status),
        );
      }
      const idx = items.findIndex((c) => c.capture_id === id);
      if (idx < 0) return answer(jsonResponse({}, 404));
      const next = {
        ...items[idx]!,
        ...(body.review_status ? { review_status: body.review_status } : {}),
        ...(body.quality ? { quality: body.quality } : {}),
        ...(body.task_result ? { task_result: body.task_result } : {}),
        review_revision: (items[idx]!.review_revision ?? 0) + 1,
      } as CaptureListItem;
      items[idx] = next;
      return answer(jsonResponse(next));
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

    if (method === 'POST' && url.endsWith('/captures/search')) {
      searchCalls.push(body);
      const query = (body.query ?? {}) as {
        predicates?: { field?: string; operator?: string; value?: string }[];
        started_from?: string | null;
        started_to?: string | null;
      };
      const matches = (
        item: CaptureListItem,
        predicate: { field?: string; operator?: string; value?: string },
      ) => {
        const value = predicate.value ?? '';
        const fieldValue = (field: string) => {
          if (field === 'condition') return item.collection_context?.condition ?? '';
          if (field === 'batch_id') return item.batch_id ?? '';
          return String(item[field as keyof CaptureListItem] ?? '');
        };
        if (predicate.field === 'any') {
          return Object.values(item)
            .join(' ')
            .toLocaleLowerCase()
            .includes(value.toLocaleLowerCase());
        }
        const actual = fieldValue(predicate.field ?? '');
        return predicate.operator === 'contains'
          ? actual.toLocaleLowerCase().includes(value.toLocaleLowerCase())
          : actual === value;
      };
      const matched = items.filter((item) => {
        const started = item.started_at ?? '';
        return (
          (query.predicates ?? []).every((predicate) => matches(item, predicate)) &&
          (!query.started_from || started >= query.started_from) &&
          (!query.started_to || started < query.started_to)
        );
      });
      const facet = (field: 'operator' | 'condition' | 'quality' | 'task_result') => {
        const values = new Map<string, number>();
        for (const item of matched) {
          const value =
            field === 'condition' ? item.collection_context?.condition : item[field];
          if (value) values.set(String(value), (values.get(String(value)) ?? 0) + 1);
        }
        return {
          values: [...values].map(([value, count]) => ({ value, count })),
          other_count: 0,
          truncated: false,
        };
      };
      return Promise.resolve(
        jsonResponse({
          items: matched,
          next_cursor: options.capturesNeverEnd ? 'more' : null,
          total: matched.length,
          facets: {
            operator: facet('operator'),
            condition: facet('condition'),
            quality: facet('quality'),
            task_result: facet('task_result'),
          },
        }),
      );
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
      return Promise.resolve(
        jsonResponse({
          items: [...items],
          next_cursor: options.capturesNeverEnd ? 'more' : null,
        }),
      );
    return Promise.resolve(jsonResponse({}));
  });

  return {
    reviewCalls,
    deleteCalls,
    pullCalls,
    searchCalls,
    items: () => items,
    /** Change what the server stores, with no client call involved — another
     *  terminal's save, seen by this one only on the next sweep. */
    setStored: (captureId: string, patch: Partial<CaptureListItem>) => {
      const idx = items.findIndex((c) => c.capture_id === captureId);
      if (idx < 0) throw new Error(`no capture ${captureId}`);
      items[idx] = {
        ...items[idx]!,
        ...patch,
        review_revision: (items[idx]!.review_revision ?? 0) + 1,
      };
    },
    /** Answer every held review save, oldest first. */
    releaseReviews: () => heldReviews.splice(0).forEach((r) => r()),
    setReviewError: (
      captureId: string,
      err: { status: number; code: string; message: string },
    ) => {
      reviewErrors[captureId] = err;
    },
    clearReviewError: (captureId: string) => {
      delete reviewErrors[captureId];
    },
  };
}

async function renderReview() {
  const view = renderHook(() => useReviewState(), { wrapper });
  await waitFor(() => expect(view.result.current.isLoading).toBe(false));
  return view;
}

beforeEach(() => {
  setApiBase('/api/v1');
  setSplitMode(false);
  history.replaceState({}, '', '/?tab=review');
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

test('keeps deep-linked facet values selectable when a limited facet omits them', async () => {
  history.replaceState({}, '', '/?tab=review&operator=remote&condition=rare');
  mockServer([
    capture({
      capture_id: 'c1',
      operator: 'ana',
      collection_context: collectionContext('left'),
    }),
  ]);

  const { result } = await renderReview();

  expect(result.current.operatorOptions).toContain('remote');
  expect(result.current.conditionOptions).toContain('rare');
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
    expect(result.current.rows.find((r) => r.captureId === 'c1')!.reviewRevision).toBe(
      3,
    ),
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
  const server = mockServer([capture({ capture_id: 'c1', run_id: 'run_a' })]);
  const { result } = await renderReview();

  // CHANGED with #12: there is no confirmation step any more — excluding keeps
  // the recording and is undoable, so both entry points act immediately. The
  // case the old confirmation test was guarding still holds below: a capture
  // with NO index_in_batch must be excludable, and it is now named by its run
  // id rather than by an episode number it does not have.
  await act(async () => result.current.requestExclude('c1'));

  await waitFor(() => expect(server.reviewCalls).toHaveLength(1));
  expect(server.reviewCalls[0]!.body).toMatchObject({
    review_status: 'excluded',
    quality: 'not_usable',
    quality_source: 'operator',
  });
  await waitFor(() => expect(result.current.nExcluded).toBe(1));
  expect(result.current.rows).toHaveLength(0);
  // Named without an episode number, and offered back.
  expect(result.current.excludeUndo).toMatchObject({
    captureId: 'c1',
    subject: 'run_a',
  });
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
  const server = mockServer(
    [capture({ capture_id: 'c1' }), capture({ capture_id: 'c2' })],
    {
      retention: {
        days: 30,
        candidates: [
          { capture_id: 'c1', state: 'completed', review_status: 'pending' },
        ],
        total_bytes: 2_048,
      },
    },
  );
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

// ---- a batch decision that partly fails must say so ------------------------
//
// The bulk REMOVAL above already reports per-capture failures. These are the
// other two bulk controls on the same screen, which move a review label rather
// than bytes. The operator's next action is to trust the count, so a run that
// reports "done" over a set where some members did not move sends them on
// believing a label exists that does not — the §12 failure the single-capture
// save path already refuses to commit.

function batchOf3(status: 'pending' | 'excluded') {
  return [
    capture({
      capture_id: 'c1',
      run_id: 'run_1',
      batch_id: 'b1',
      review_status: status,
    }),
    capture({
      capture_id: 'c2',
      run_id: 'run_2',
      batch_id: 'b1',
      review_status: status,
    }),
    capture({
      capture_id: 'c3',
      run_id: 'run_3',
      batch_id: 'b1',
      review_status: status,
    }),
  ];
}

const SIDECAR_500 = {
  status: 500,
  code: 'review_sidecar_write_failed',
  message: 'record.json could not be written',
};

const CONFLICT_409 = {
  status: 409,
  code: 'review_conflict',
  message: 'someone saved first',
};

/** Two members failing for DIFFERENT reasons, which is what pins where each
 *  message came from. A `save` parks its reading in the hook's shared banner
 *  as well as returning it, and reading the batch's messages off that banner
 *  looks identical while there is only one failure — so these two tests are
 *  the only thing standing between "the reason for THIS capture" and
 *  "whichever reason landed last". The 409 makes it sharper still: a conflict
 *  goes to `conflict`, not `failure`, so a banner-sourced message could not
 *  carry it at all. */
function expectDistinctReasons(failures: { captureId: string; error: string }[]) {
  const byId = Object.fromEntries(failures.map((f) => [f.captureId, f.error]));
  expect(byId.c2).toContain('record.json');
  expect(byId.c3).toContain('Someone else saved');
  expect(byId.c2).not.toBe(byId.c3);
}

test('a batch exclude names the members it could not exclude', async () => {
  const server = mockServer(batchOf3('pending'), { reviewErrors: { c2: SIDECAR_500 } });
  const { result } = await renderReview();
  act(() => result.current.toggleBatchFilter('b1'));
  await waitFor(() => expect(result.current.batchExcludable).toHaveLength(3));

  act(() => result.current.requestExcludeBatch());
  await act(async () => result.current.confirmExcludeBatch());
  await waitFor(() => expect(result.current.excludeBatchRunning).toBe(false));

  // One failure does not end the sweep: the members after it still get their
  // chance, or a single bad row would silently halve the batch.
  expect(server.reviewCalls.map((c) => c.captureId)).toEqual(['c1', 'c2', 'c3']);
  expect(result.current.excludeBatchFailures.map((f) => f.captureId)).toEqual(['c2']);
  // The count is what SUCCEEDED, beside the count that did not.
  expect(result.current.toast).toBe('Excluded 2, 1 failed');
  // And the dialog stays up — closing it on a partial failure is how the
  // report gets missed.
  expect(result.current.excludeBatchOpen).toBe(true);
});

test('a batch return to review names the members it could not return', async () => {
  const server = mockServer(batchOf3('excluded'), {
    reviewErrors: { c2: SIDECAR_500 },
  });
  const { result } = await renderReview();
  act(() => result.current.toggleBatchFilter('b1'));
  await waitFor(() => expect(result.current.batchExcluded).toHaveLength(3));

  await act(async () => result.current.returnBatchToReview());
  await waitFor(() => expect(server.reviewCalls).toHaveLength(3));

  // Same rule as the exclude above. "Returned 2" over a set of 3 is a partial
  // failure wearing a success's clothes: c2 is still excluded, and nothing has
  // told the operator which one stayed behind.
  await waitFor(() => expect(result.current.toast).toBe('Returned 2, 1 failed'));
  expect(result.current.returnBatchFailures.map((f) => f.captureId)).toEqual(['c2']);

  // The list converges without a manual reload: the optimistic "pending" is
  // rolled back for the one that failed, so nothing is left reading as though
  // it moved while the server says it did not.
  await waitFor(() =>
    expect(result.current.excludedRows.map((r) => r.captureId)).toEqual(['c2']),
  );
  // Note it converges OUT of the default view — still-excluded rows are hidden
  // unless "show excluded" is on. The operator therefore cannot find the
  // failure by scanning the table, which is why the report has to name it.
  expect(result.current.rows.map((r) => r.captureId).sort()).toEqual(['c1', 'c3']);

  // The notice carries a count and no batch, so it must not outlive the batch
  // it belongs to.
  act(() => result.current.toggleBatchFilter(null));
  expect(result.current.returnBatchFailures).toEqual([]);
});

test('each failed exclude carries ITS OWN reason, not the last one raised', async () => {
  mockServer(batchOf3('pending'), {
    reviewErrors: { c2: SIDECAR_500, c3: CONFLICT_409 },
  });
  const { result } = await renderReview();
  act(() => result.current.toggleBatchFilter('b1'));
  await waitFor(() => expect(result.current.batchExcludable).toHaveLength(3));

  act(() => result.current.requestExcludeBatch());
  await act(async () => result.current.confirmExcludeBatch());
  await waitFor(() => expect(result.current.excludeBatchRunning).toBe(false));

  expectDistinctReasons(result.current.excludeBatchFailures);
  expect(result.current.toast).toBe('Excluded 1, 2 failed');
});

test('each failed return carries ITS OWN reason, not the last one raised', async () => {
  mockServer(batchOf3('excluded'), {
    reviewErrors: { c2: SIDECAR_500, c3: CONFLICT_409 },
  });
  const { result } = await renderReview();
  act(() => result.current.toggleBatchFilter('b1'));
  await waitFor(() => expect(result.current.batchExcluded).toHaveLength(3));

  await act(async () => result.current.returnBatchToReview());
  await waitFor(() => expect(result.current.returnBatchFailures).toHaveLength(2));

  expectDistinctReasons(result.current.returnBatchFailures);
  expect(result.current.toast).toBe('Returned 1, 2 failed');
});

test('a successful exclude clears a previous return failure notice', async () => {
  // The notice says "still excluded — return failed". After the operator
  // excludes the batch on purpose those episodes are excluded BY INTENT, so
  // the sentence is still literally true and completely misleading.
  const server = mockServer(batchOf3('excluded'), {
    reviewErrors: { c2: SIDECAR_500 },
  });
  const { result } = await renderReview();
  act(() => result.current.toggleBatchFilter('b1'));
  await waitFor(() => expect(result.current.batchExcluded).toHaveLength(3));

  await act(async () => result.current.returnBatchToReview());
  await waitFor(() => expect(result.current.returnBatchFailures).toHaveLength(1));

  // c2 stayed excluded; c1 and c3 came back and can now be excluded again.
  await waitFor(() => expect(result.current.batchExcludable).toHaveLength(2));
  server.reviewCalls.length = 0;
  act(() => result.current.requestExcludeBatch());
  await act(async () => result.current.confirmExcludeBatch());
  await waitFor(() => expect(result.current.excludeBatchRunning).toBe(false));

  expect(result.current.returnBatchFailures).toEqual([]);
});

test('opening the exclude dialog and backing out leaves the notice alone', async () => {
  // The other side of the test above, and the reason the clearing sits in
  // confirm rather than request. Opening a dialog decides nothing: the
  // operator is still reading, and this notice — "c2 is still excluded, its
  // return failed" — is part of what they are reading it against. Clearing on
  // open would take it away at the moment it is most useful and, if they back
  // out, leave nothing on screen about a failure that has not been addressed.
  mockServer(batchOf3('excluded'), { reviewErrors: { c2: SIDECAR_500 } });
  const { result } = await renderReview();
  act(() => result.current.toggleBatchFilter('b1'));
  await waitFor(() => expect(result.current.batchExcluded).toHaveLength(3));

  await act(async () => result.current.returnBatchToReview());
  await waitFor(() =>
    expect(result.current.returnBatchFailures.map((f) => f.captureId)).toEqual(['c2']),
  );

  act(() => result.current.requestExcludeBatch());
  expect(result.current.returnBatchFailures.map((f) => f.captureId)).toEqual(['c2']);
  act(() => result.current.cancelExcludeBatch());
  expect(result.current.returnBatchFailures.map((f) => f.captureId)).toEqual(['c2']);
});

// ---- one save at a time (§4.1) -------------------------------------------
//
// `base_revision` is read off the capture the LIST holds, and the list does not
// move until the save lands. A second decision taken while the first is still
// in flight therefore carries the same, already-spent revision, and the server
// refuses it. Nothing about that refusal is a conflict — the only terminal
// involved is this one — so it is prevented rather than classified.

test('a second decision taken while the first save is in flight is never sent', async () => {
  const server = mockServer(
    [capture({ capture_id: 'c1', review_revision: 4, quality: 'good' })],
    { holdReviews: true },
  );
  const { result } = await renderReview();
  act(() => result.current.select('c1'));

  // Positive control: the first click really does put a request on the wire.
  // `save` issues its fetch in a microtask, so a synchronous assertion here
  // would report "nothing fired" for a request that did.
  act(() => result.current.cycleFinalQuality());
  await waitFor(() => expect(server.reviewCalls).toHaveLength(1));
  expect(result.current.rows.find((r) => r.captureId === 'c1')!.effectiveQuality).toBe(
    'Needs review',
  );

  // The operator clicks again before the answer arrives. The tile invites it:
  // its own tooltip puts the third value two clicks away.
  act(() => result.current.cycleFinalQuality());
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

  expect(server.reviewCalls).toHaveLength(1);
  // The refusal also came BEFORE the optimistic overlay was touched. Refusing
  // any later would set an overlay and then clear it, and the clear takes the
  // FIRST save's value with it — the row would snap back to Good while the
  // save that is writing "Needs review" is still unanswered.
  expect(result.current.rows.find((r) => r.captureId === 'c1')!.effectiveQuality).toBe(
    'Needs review',
  );

  await act(async () => {
    server.releaseReviews();
  });
  expect(server.reviewCalls).toHaveLength(1);
  expect(server.reviewCalls[0]!.body.base_revision).toBe(4);
  // No conflict was manufactured out of the operator's own save.
  expect(result.current.reviewSave.conflict).toBeNull();
});

test('two decisions dispatched in the same tick still send one, and keep the overlay', async () => {
  // Two mouse clicks cannot do this — React commits between discrete events —
  // so this pins WHY the gate is ref-backed rather than read off the state
  // the screen renders from. A state-backed gate answers `false` to both
  // calls here, because neither has seen a render yet. The bag-import dialog
  // learned the same lesson from its own double-press (`runInFlight`).
  //
  // The request count alone would not show it: `save` holds the same ref and
  // would refuse the second write regardless. What a state-backed gate loses
  // is the EARLY return — the second call would reach the overlay, set it and
  // clear it, and take the in-flight save's value down with it.
  const server = mockServer(
    [capture({ capture_id: 'c1', review_revision: 4, quality: 'good' })],
    { holdReviews: true },
  );
  const { result } = await renderReview();
  act(() => result.current.select('c1'));

  await act(async () => {
    result.current.cycleFinalQuality();
    result.current.cycleFinalQuality();
  });

  expect(server.reviewCalls).toHaveLength(1);
  expect(result.current.rows.find((r) => r.captureId === 'c1')!.effectiveQuality).toBe(
    'Needs review',
  );
  await act(async () => {
    server.releaseReviews();
  });
});

test('the same double click on Mark OK sends one adoption, not two', async () => {
  const server = mockServer([capture({ capture_id: 'c1', review_revision: 4 })], {
    holdReviews: true,
  });
  const { result } = await renderReview();
  act(() => result.current.select('c1'));

  act(() => result.current.markOk());
  await waitFor(() => expect(server.reviewCalls).toHaveLength(1));
  act(() => result.current.markOk());
  await act(async () => {
    server.releaseReviews();
  });

  expect(server.reviewCalls).toHaveLength(1);
  expect(result.current.reviewSave.conflict).toBeNull();
});

test('a save in flight holds back only its own capture', async () => {
  // Per capture, not a screen-wide freeze. Two captures saving at once is
  // ordinary — each carries its own revision, so neither can spend the
  // other's — and the batch tools depend on being able to walk a set.
  const server = mockServer(
    [
      capture({ capture_id: 'c1', review_revision: 4 }),
      capture({ capture_id: 'c2', review_revision: 7 }),
    ],
    { holdReviews: true },
  );
  const { result } = await renderReview();

  act(() => result.current.select('c1'));
  act(() => result.current.markOk());
  await waitFor(() => expect(server.reviewCalls).toHaveLength(1));

  act(() => result.current.select('c2'));
  act(() => result.current.markOk());
  await waitFor(() => expect(server.reviewCalls).toHaveLength(2));

  await act(async () => {
    server.releaseReviews();
  });
  expect(server.reviewCalls.map((c) => c.captureId)).toEqual(['c1', 'c2']);
});

test('the gate reopens when the save lands, and a REAL conflict still speaks', async () => {
  // The half that must not regress. A 409 raised because another terminal got
  // there first is the whole point of the compare-and-swap, and refusing the
  // operator's own second click must not cost them that warning.
  const server = mockServer([capture({ capture_id: 'c1', review_revision: 4 })], {
    reviewErrors: {
      c1: { status: 409, code: 'review_conflict', message: 'edited elsewhere' },
    },
  });
  const { result } = await renderReview();
  act(() => result.current.select('c1'));

  await act(async () => result.current.markOk());
  await waitFor(() => expect(result.current.reviewSave.conflict).not.toBeNull());
  expect(result.current.reviewSave.conflict!.reading.code).toBe('review_conflict');
  expect(server.reviewCalls).toHaveLength(1);

  // And the gate did not stay shut behind the refusal: the operator can act
  // again once they have read the banner. A gate that never reopened would
  // leave the assertion above green while making the screen unusable.
  await act(async () => result.current.markOk());
  expect(server.reviewCalls).toHaveLength(2);
});

test('a bulk run reports a member it stepped over, and does not call it a failure', async () => {
  // The window the gate opens: the operator decides on one episode, then runs
  // a batch over a set that contains it before the answer arrives. The batch
  // writes nothing for that episode — which it must say, because the episode
  // is NOT excluded — but the server refused nothing, so "save failed" would
  // send the operator hunting for a fault that does not exist.
  const server = mockServer(batchOf3('pending'), { holdReviews: true });
  const { result } = await renderReview();
  act(() => result.current.toggleBatchFilter('b1'));
  await waitFor(() => expect(result.current.batchExcludable).toHaveLength(3));

  act(() => result.current.select('c1'));
  act(() => result.current.markOk());
  await waitFor(() => expect(server.reviewCalls).toHaveLength(1));

  act(() => result.current.requestExcludeBatch());
  act(() => result.current.confirmExcludeBatch());
  // c1 is stepped over without a request; the loop then blocks on c2.
  await waitFor(() => expect(server.reviewCalls).toHaveLength(2));
  // Each release answers whatever is held right now, which lets the loop move
  // on and issue the next one; four passes cover the adoption plus c2 and c3.
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      server.releaseReviews();
    });
  }
  await waitFor(() => expect(result.current.excludeBatchRunning).toBe(false));

  expect(server.reviewCalls.map((c) => c.captureId)).toEqual(['c1', 'c2', 'c3']);
  const skipped = result.current.excludeBatchFailures.find(
    (f) => f.captureId === 'c1',
  )!;
  expect(skipped).toBeDefined();
  expect(skipped.error).toMatch(/still being written/);
  expect(skipped.error).not.toMatch(/save failed/);
  // And it is counted, not quietly dropped: 2 of the 3 went.
  expect(result.current.toast).toBe('Excluded 2, 1 failed');
});

// ---- a banner belongs to ONE capture ------------------------------------
//
// A save that lands supersedes a banner about the SAME capture — the operator
// re-applied their decision and it took. It says nothing about a different
// capture, whose refusal is still unaddressed and whose stored value is still
// the other terminal's.

test('a real conflict on one capture survives a successful save on another', async () => {
  const errors = {
    c1: { status: 409, code: 'review_conflict', message: 'edited elsewhere' },
  };
  const server = mockServer(
    [
      capture({ capture_id: 'c1', review_revision: 4 }),
      capture({ capture_id: 'c2', review_revision: 4 }),
    ],
    { reviewErrors: errors },
  );
  const { result } = await renderReview();

  // Another terminal got to c1 first.
  act(() => result.current.select('c1'));
  await act(async () => result.current.markOk());
  await waitFor(() => expect(result.current.reviewSave.conflict).not.toBeNull());
  expect(result.current.reviewSave.conflict!.captureId).toBe('c1');

  // The operator moves on and adopts a different episode, which works.
  act(() => result.current.select('c2'));
  await act(async () => result.current.markOk());
  await waitFor(() =>
    expect(result.current.rows.find((r) => r.captureId === 'c2')!.reviewStatus).toBe(
      'adopted',
    ),
  );

  // c1's refusal is still on screen. Nothing has addressed it: c1 still holds
  // whatever the other terminal wrote, and the operator's decision for it was
  // never applied.
  expect(result.current.reviewSave.conflict).not.toBeNull();
  expect(result.current.reviewSave.conflict!.captureId).toBe('c1');
  // c1 was attempted exactly once and never retried behind the operator's
  // back — the whole point of the compare-and-swap (this mock records refused
  // attempts too, so a silent retry would show up here as a second 'c1').
  expect(server.reviewCalls.map((c) => c.captureId)).toEqual(['c1', 'c2']);
});

test('a save that lands DOES clear the banner about its own capture', async () => {
  // The other direction, and the reason the rule is per capture rather than
  // "never clear": once the operator reloads and re-applies successfully, the
  // banner is describing something that is no longer true. Without this the
  // fix above would leave a stale accusation that only Dismiss could remove.
  const errors: Record<string, { status: number; code: string; message: string }> = {
    c1: { status: 409, code: 'review_conflict', message: 'edited elsewhere' },
  };
  mockServer([capture({ capture_id: 'c1', review_revision: 4 })], {
    reviewErrors: errors,
  });
  const { result } = await renderReview();
  act(() => result.current.select('c1'));
  await act(async () => result.current.markOk());
  await waitFor(() => expect(result.current.reviewSave.conflict).not.toBeNull());

  delete errors.c1;
  await act(async () => result.current.markOk());
  await waitFor(() => expect(result.current.reviewSave.conflict).toBeNull());
});

test('a 500 that saved NOTHING also survives a successful save on another capture', async () => {
  // §12 puts a heavier duty on this one than on the conflict: its severity is
  // `destructive` precisely because the operator would otherwise walk away
  // believing a label exists that does not. A success somewhere else is not
  // an acknowledgement of it.
  const errors = {
    c1: {
      status: 500,
      code: 'review_sidecar_write_failed',
      message: 'could not write record.json',
    },
  };
  mockServer(
    [
      capture({ capture_id: 'c1', review_revision: 4 }),
      capture({ capture_id: 'c2', review_revision: 4 }),
    ],
    { reviewErrors: errors },
  );
  const { result } = await renderReview();

  act(() => result.current.select('c1'));
  await act(async () => result.current.markOk());
  await waitFor(() => expect(result.current.reviewSave.failure).not.toBeNull());
  expect(result.current.reviewSave.failure!.severity).toBe('destructive');

  act(() => result.current.select('c2'));
  await act(async () => result.current.markOk());
  await waitFor(() =>
    expect(result.current.rows.find((r) => r.captureId === 'c2')!.reviewStatus).toBe(
      'adopted',
    ),
  );

  expect(result.current.reviewSave.failure).not.toBeNull();
  expect(result.current.reviewSave.failure!.code).toBe('review_sidecar_write_failed');
});

test('a banner names its capture even when the filters have hidden it', async () => {
  // The subject is a property of the capture, not of the view. A banner
  // survives a filter change, and reading the name off the FILTERED rows
  // would make it degrade to a raw id exactly when the operator has narrowed
  // the table — a normal thing to do while chasing what went wrong.
  mockServer([
    capture({ capture_id: 'c1', run_id: 'run_1', index_in_batch: 1, operator: 'ana' }),
    capture({ capture_id: 'c2', run_id: 'run_2', index_in_batch: 2, operator: 'bo' }),
    // No index_in_batch: there is no episode number to show, so the run_id
    // carries the identity rather than an honest but useless "Episode —".
    capture({ capture_id: 'c3', run_id: 'run_3', operator: 'bo' }),
  ]);
  const { result } = await renderReview();

  expect(result.current.captureSubject('c1')).toBe('Episode #1');
  expect(result.current.captureSubject('c3')).toBe('run_3');

  act(() => result.current.setOperatorFilter('bo'));
  await waitFor(() =>
    expect(result.current.rows.some((r) => r.captureId === 'c1')).toBe(false),
  );
  expect(result.current.captureSubject('c1')).toBe('Episode #1');
});

test('sends UTC calendar-day bounds and server predicates for Review filters', async () => {
  const server = mockServer([
    capture({
      capture_id: 'c1',
      operator: 'ana',
      collection_context: collectionContext('left'),
      started_at: '2026-08-01T12:00:00.000Z',
    }),
  ]);
  const { result } = await renderReview();

  act(() => {
    result.current.setSearch('pick');
    result.current.setOperatorFilter('ana');
    result.current.setConditionFilter('left');
    result.current.setQualityFilter('good');
    result.current.setResultFilter('failure');
    result.current.setStartedFrom('2026-08-01');
    result.current.setStartedTo('2026-08-01');
  });

  await waitFor(() =>
    expect(server.searchCalls.at(-1)).toMatchObject({
      query: {
        predicates: [
          { field: 'any', operator: 'contains', value: 'pick' },
          { field: 'operator', operator: 'equals', value: 'ana' },
          { field: 'quality', operator: 'equals', value: 'good' },
          { field: 'task_result', operator: 'equals', value: 'failure' },
          { field: 'condition', operator: 'equals', value: 'left' },
        ],
        started_from: '2026-08-01T00:00:00.000Z',
        started_to: '2026-08-02T00:00:00.000Z',
      },
    }),
  );
});

test('a displaced failure notice loses the reason, not the fact', async () => {
  // `conflict` and `failure` are one slot each, not lists, so a second failure
  // displaces the first. That became reachable when banners started outliving
  // the selection, and the question is whether it is a correctness problem.
  //
  // It is not, and this is the evidence rather than the assertion: a refused
  // save reverts its optimistic change, so the displaced capture is still
  // sitting in the work queue, unreviewed, with its revision unmoved. What the
  // operator loses is the sentence explaining why — not the fact that it needs
  // attention. If that ever stops being true, this fails and the single-slot
  // design has to be re-argued.
  const SIDECAR = {
    status: 500,
    code: 'review_sidecar_write_failed',
    message: 'could not write record.json',
  };
  mockServer(
    [
      capture({ capture_id: 'c1', review_revision: 4 }),
      capture({ capture_id: 'c2', review_revision: 4 }),
    ],
    { reviewErrors: { c1: SIDECAR, c2: SIDECAR } },
  );
  const { result } = await renderReview();

  act(() => result.current.select('c1'));
  await act(async () => result.current.markOk());
  await waitFor(() => expect(result.current.reviewSave.failureCaptureId).toBe('c1'));

  act(() => result.current.select('c2'));
  await act(async () => result.current.markOk());
  await waitFor(() => expect(result.current.reviewSave.failureCaptureId).toBe('c2'));

  // c1's banner is gone. c1 itself is not.
  const c1 = result.current.rows.find((r) => r.captureId === 'c1')!;
  expect(c1.reviewLane).toBe('needs_check');
  expect(c1.effectiveReviewStatus).toBe('pending');
  expect(c1.effectiveQuality).toBeNull();
  // The revision never moved, which is the proof that nothing was written.
  expect(c1.reviewRevision).toBe(4);
  // And it is still counted in the queue the operator works from.
  expect(result.current.nNeedsCheck).toBe(2);
});

// ---- server page boundaries ----------------------------------------------

test('a server page with a next cursor reports its bounded scope', async () => {
  mockServer([capture({ capture_id: 'c1' })], { capturesNeverEnd: true });
  const { result } = await renderReview();

  expect(result.current.catalogTruncated).toBe(true);
  // The rows it did fetch are still usable — this is a caveat, not an error.
  expect(result.current.rows.length).toBeGreaterThan(0);
});

test('follows and pops the server cursor stack', async () => {
  const server = mockServer([capture({ capture_id: 'c1' })], {
    capturesNeverEnd: true,
  });
  const { result } = await renderReview();

  expect(result.current.hasPreviousPage).toBe(false);
  act(() => result.current.nextPage());
  await waitFor(() => expect(result.current.hasPreviousPage).toBe(true));
  expect(server.searchCalls.at(-1)).toMatchObject({ cursor: 'more' });

  act(() => result.current.previousPage());
  await waitFor(() => expect(result.current.hasPreviousPage).toBe(false));
  expect(window.location.search).not.toContain('cursor=');
});

test('a catalog that fits reports nothing — the flag is not decoration', async () => {
  mockServer([capture({ capture_id: 'c1' })]);
  const { result } = await renderReview();

  expect(result.current.catalogTruncated).toBe(false);
});

// ---- undoing an exclude (#12) ---------------------------------------------
//
// Excluding overwrites review_status AND quality, and Return only ever writes
// `pending` — so taking back a mis-click on an adopted capture used to mean two
// actions and still lost the quality it had been carrying. What the exclude
// overwrote is remembered client-side for the session and put back in one save.

test('undo restores the exact status and quality the exclude overwrote', async () => {
  const server = mockServer([
    capture({
      capture_id: 'c1',
      index_in_batch: 3,
      review_status: 'adopted',
      quality: 'good',
      quality_source: 'operator',
      review_revision: 1,
    }),
  ]);
  const { result } = await renderReview();

  await act(async () => result.current.requestExclude('c1'));
  await waitFor(() => expect(server.reviewCalls).toHaveLength(1));
  expect(result.current.excludeUndo).toMatchObject({
    captureId: 'c1',
    subject: 'Episode #3',
    prior: { review_status: 'adopted', quality: 'good', quality_source: 'operator' },
  });

  await act(async () => result.current.undoExclude());

  await waitFor(() => expect(server.reviewCalls).toHaveLength(2));
  // One save, carrying all three fields the exclude touched. Return would have
  // sent `pending` alone and left the capture reading "Not usable".
  expect(server.reviewCalls[1]!.body).toMatchObject({
    review_status: 'adopted',
    quality: 'good',
    quality_source: 'operator',
  });
  await waitFor(() => expect(result.current.nExcluded).toBe(0));
  expect(result.current.excludeUndo).toBeNull();
});

test('a capture with no operator quality has the not_usable cleared, not kept', async () => {
  const server = mockServer([capture({ capture_id: 'c1', index_in_batch: 1 })]);
  const { result } = await renderReview();

  await act(async () => result.current.requestExclude('c1'));
  await waitFor(() => expect(server.reviewCalls).toHaveLength(1));
  await act(async () => result.current.undoExclude());
  await waitFor(() => expect(server.reviewCalls).toHaveLength(2));

  // Nulls are sent EXPLICITLY, because the server distinguishes "omitted" from
  // "null" by `model_fields_set` (capture_review.py `_merge_review`): omitting
  // them means "leave these alone", and leaving them alone is how the capture
  // would keep the not_usable the exclude wrote — an undo that restores the
  // status and silently keeps the verdict.
  //
  // What the capture ends up with is then the SERVER's business, and it is not
  // null: `_derive_quality` refills an explicitly-null quality from the
  // capture's quick-check verdict (falling back to needs_review) and marks it
  // `quick_check`. That is the right end state for a capture whose quality no
  // operator had ever set — it goes back to being machine-judged — but it is
  // the reason this test asserts the REQUEST and not a restored null.
  const body = server.reviewCalls[1]!.body as Record<string, unknown>;
  expect(body).toMatchObject({ review_status: 'pending' });
  expect(body.quality).toBeNull();
  expect(body.quality_source).toBeNull();

  // And the toast says so, in that branch only. "restored to Pending" alone
  // would let a quality the operator did not choose arrive unannounced.
  await waitFor(() =>
    expect(result.current.toast).toContain('quality re-derived from quick check'),
  );
});

test('the detail-panel Exclude takes the same path, undo and all', async () => {
  const server = mockServer([
    capture({
      capture_id: 'c1',
      index_in_batch: 2,
      review_status: 'adopted',
      quality: 'needs_review',
      quality_source: 'validator',
      review_revision: 1,
    }),
  ]);
  const { result } = await renderReview();

  act(() => result.current.select('c1'));
  await act(async () => result.current.decide('excluded'));

  await waitFor(() => expect(server.reviewCalls).toHaveLength(1));
  // It used to write review_status alone: no quality change, nothing
  // remembered. Now it is the same operation the table performs.
  expect(server.reviewCalls[0]!.body).toMatchObject({
    review_status: 'excluded',
    quality: 'not_usable',
    quality_source: 'operator',
  });
  expect(result.current.excludeUndo).toMatchObject({ captureId: 'c1' });

  await act(async () => result.current.undoExclude());
  await waitFor(() => expect(server.reviewCalls).toHaveLength(2));
  // A validator's verdict goes back as the VALIDATOR's. Restoring it as
  // 'operator' would put a human's name on a machine's judgement.
  expect(server.reviewCalls[1]!.body).toMatchObject({
    review_status: 'adopted',
    quality: 'needs_review',
    quality_source: 'validator',
  });
});

test('a refused exclude offers no undo — there is nothing to take back', async () => {
  mockServer([capture({ capture_id: 'c1', index_in_batch: 1 })], {
    reviewErrors: {
      c1: { status: 500, code: 'review_sidecar_write_failed', message: 'no write' },
    },
  });
  const { result } = await renderReview();

  await act(async () => result.current.requestExclude('c1'));

  await waitFor(() => expect(result.current.reviewSave.failure).not.toBeNull());
  expect(result.current.excludeUndo).toBeNull();
  expect(result.current.nExcluded).toBe(0);
});

test('a refused undo keeps the offer, so it can be tried again', async () => {
  const server = mockServer([capture({ capture_id: 'c1', index_in_batch: 1 })]);
  const { result } = await renderReview();

  await act(async () => result.current.requestExclude('c1'));
  await waitFor(() => expect(result.current.excludeUndo).not.toBeNull());

  // The next save is refused: the restore does not land.
  server.setReviewError('c1', {
    status: 409,
    code: 'review_conflict',
    message: 'someone saved first',
  });
  await act(async () => result.current.undoExclude());
  await waitFor(() => expect(result.current.reviewSave.conflict).not.toBeNull());
  expect(result.current.excludeUndo).not.toBeNull();

  // …and once the refusal clears, the same offer still restores it.
  server.clearReviewError('c1');
  await act(async () => result.current.undoExclude());
  await waitFor(() => expect(result.current.excludeUndo).toBeNull());
  expect(result.current.nExcluded).toBe(0);
});

test('a second exclude supersedes the first offer — one undo, for the last action', async () => {
  const server = mockServer([
    capture({ capture_id: 'c1', index_in_batch: 1 }),
    capture({ capture_id: 'c2', index_in_batch: 2 }),
  ]);
  const { result } = await renderReview();

  await act(async () => result.current.requestExclude('c1'));
  await waitFor(() => expect(result.current.excludeUndo?.captureId).toBe('c1'));
  await act(async () => result.current.requestExclude('c2'));
  await waitFor(() => expect(result.current.excludeUndo?.captureId).toBe('c2'));

  // Undoing now restores c2. c1 stays excluded — the offer never claimed
  // otherwise, and Return is still there for it.
  await act(async () => result.current.undoExclude());
  await waitFor(() => expect(server.reviewCalls).toHaveLength(3));
  expect(result.current.nExcluded).toBe(1);
});

test('returning to review says the step that is still outstanding', async () => {
  mockServer([
    capture({
      capture_id: 'c1',
      index_in_batch: 1,
      review_status: 'excluded',
      review_revision: 1,
    }),
  ]);
  const { result } = await renderReview();
  await waitFor(() => expect(result.current.nExcluded).toBe(1));

  await act(async () => result.current.requestExclude('c1'));

  // "Restored" read as finished; the capture was sitting at `pending`, which
  // Datasets do not take.
  await waitFor(() =>
    expect(result.current.toast).toContain('Adopt to include in datasets'),
  );
  expect(result.current.toast).toContain('returned to review');
});

test('dismissing the offer leaves the exclusion in place', async () => {
  const server = mockServer([capture({ capture_id: 'c1', index_in_batch: 1 })]);
  const { result } = await renderReview();

  await act(async () => result.current.requestExclude('c1'));
  await waitFor(() => expect(result.current.excludeUndo).not.toBeNull());
  act(() => result.current.dismissExcludeUndo());

  expect(result.current.excludeUndo).toBeNull();
  expect(result.current.nExcluded).toBe(1);
  expect(server.reviewCalls).toHaveLength(1);
});

test('deleting the capture takes its undo offer with it', async () => {
  // The offer would otherwise be a button whose only possible outcome is a
  // failure: there is no row left to restore the review onto.
  const server = mockServer([capture({ capture_id: 'c1', index_in_batch: 1 })]);
  const { result } = await renderReview();

  await act(async () => result.current.requestExclude('c1'));
  await waitFor(() => expect(result.current.excludeUndo).not.toBeNull());

  act(() => result.current.requestDelete(['c1']));
  await act(async () => result.current.deletion.confirm(''));

  await waitFor(() => expect(server.deleteCalls).toHaveLength(1));
  await waitFor(() => expect(result.current.excludeUndo).toBeNull());
});

test('a batch exclude supersedes a single capture’s undo offer', async () => {
  // Left standing, "Episode #1 excluded — Undo" sits over a batch that just
  // excluded three others and reads as the undo for what was done last.
  mockServer(batchOf3('pending'));
  const { result } = await renderReview();

  await act(async () => result.current.requestExclude('c1'));
  await waitFor(() => expect(result.current.excludeUndo).not.toBeNull());

  act(() => result.current.toggleBatchFilter('b1'));
  await waitFor(() => expect(result.current.batchExcludable).toHaveLength(2));
  act(() => result.current.requestExcludeBatch());
  await act(async () => result.current.confirmExcludeBatch());

  await waitFor(() => expect(result.current.excludeUndo).toBeNull());
});

// ---- the offer must not outlive the exclusion it belongs to (PR #21 R1) ----
//
// The damage is specific and silent: exclude a PENDING capture, decide the
// other way instead, and a stale offer writes `pending` over the new decision
// while reporting success. Every route back out of an exclusion is covered
// here, because the bug is not in any one of them — it is in the offer
// outliving the state it describes.

test('adopting the capture instead retires the offer — no silent demotion', async () => {
  const server = mockServer([capture({ capture_id: 'c1', index_in_batch: 1 })]);
  const { result } = await renderReview();

  await act(async () => result.current.requestExclude('c1'));
  await waitFor(() => expect(result.current.excludeUndo).not.toBeNull());

  act(() => result.current.select('c1'));
  await act(async () => result.current.markOk());
  await waitFor(() => expect(server.reviewCalls).toHaveLength(2));

  // Gone. Taking it would have written `pending` over the adoption just made.
  expect(result.current.excludeUndo).toBeNull();
  await act(async () => result.current.undoExclude());
  expect(server.reviewCalls).toHaveLength(2);
  expect(
    result.current.rows.find((r) => r.captureId === 'c1')!.effectiveReviewStatus,
  ).toBe('adopted');
});

test('adopting DISCARDS the memo, so a later exclusion cannot resurrect it', async () => {
  // Kept apart from the test above, where the undo call does the clearing
  // itself (the write-time check) and would hide whether Adopt cleared
  // anything. Nothing here touches the offer except Adopt.
  const server = mockServer([capture({ capture_id: 'c1', index_in_batch: 1 })]);
  const { result } = await renderReview();

  await act(async () => result.current.requestExclude('c1'));
  await waitFor(() => expect(result.current.excludeUndo).not.toBeNull());
  act(() => result.current.select('c1'));
  await act(async () => result.current.markOk());
  await waitFor(() => expect(result.current.excludeUndo).toBeNull());

  // Excluded again, by another terminal. A memo merely HIDDEN comes back into
  // view here, carrying a prior from two decisions ago.
  await act(async () => {
    server.setStored('c1', { review_status: 'excluded' });
    await result.current.reviewSave.invalidateList();
  });
  await waitFor(() =>
    expect(result.current.rows.find((r) => r.captureId === 'c1')).toBeUndefined(),
  );
  expect(result.current.excludeUndo).toBeNull();
});

test('the row Return retires the offer', async () => {
  const server = mockServer([capture({ capture_id: 'c1', index_in_batch: 1 })]);
  const { result } = await renderReview();

  await act(async () => result.current.requestExclude('c1'));
  await waitFor(() => expect(result.current.excludeUndo).not.toBeNull());
  // Second call on an excluded row IS the Return.
  await act(async () => result.current.requestExclude('c1'));

  await waitFor(() => expect(server.reviewCalls).toHaveLength(2));
  expect(result.current.excludeUndo).toBeNull();
  // The clear is not redundant with the guard: leave the memo alive and a LATER
  // exclusion (here, from another terminal) makes the guard show it again —
  // an offer whose remembered prior belongs to an exclusion two decisions ago.
  await act(async () => {
    server.setStored('c1', { review_status: 'excluded' });
    await result.current.reviewSave.invalidateList();
  });
  await waitFor(() =>
    expect(result.current.rows.find((r) => r.captureId === 'c1')).toBeUndefined(),
  );
  expect(result.current.excludeUndo).toBeNull();
});

test("the detail panel's Return retires the offer", async () => {
  const server = mockServer([capture({ capture_id: 'c1', index_in_batch: 1 })]);
  const { result } = await renderReview();

  await act(async () => result.current.requestExclude('c1'));
  await waitFor(() => expect(result.current.excludeUndo).not.toBeNull());
  act(() => result.current.select('c1'));
  await act(async () => result.current.decide('review'));

  await waitFor(() => expect(server.reviewCalls).toHaveLength(2));
  expect(result.current.excludeUndo).toBeNull();
  // The clear is not redundant with the guard: leave the memo alive and a LATER
  // exclusion (here, from another terminal) makes the guard show it again —
  // an offer whose remembered prior belongs to an exclusion two decisions ago.
  await act(async () => {
    server.setStored('c1', { review_status: 'excluded' });
    await result.current.reviewSave.invalidateList();
  });
  await waitFor(() =>
    expect(result.current.rows.find((r) => r.captureId === 'c1')).toBeUndefined(),
  );
  expect(result.current.excludeUndo).toBeNull();
});

test('a batch return that sweeps the capture up retires the offer', async () => {
  const server = mockServer(batchOf3('pending'));
  const { result } = await renderReview();

  await act(async () => result.current.requestExclude('c1'));
  await waitFor(() => expect(result.current.excludeUndo).not.toBeNull());

  act(() => result.current.toggleBatchFilter('b1'));
  await waitFor(() => expect(result.current.batchExcluded).toHaveLength(1));
  await act(async () => result.current.returnBatchToReview());

  await waitFor(() => expect(result.current.excludeUndo).toBeNull());

  // As above: the memo has to be GONE, not merely hidden, or a later exclusion
  // brings back a prior belonging to an exclusion two decisions ago.
  await act(async () => {
    server.setStored('c1', { review_status: 'excluded' });
    await result.current.reviewSave.invalidateList();
  });
  await waitFor(() =>
    expect(result.current.rows.find((r) => r.captureId === 'c1')).toBeUndefined(),
  );
  expect(result.current.excludeUndo).toBeNull();
});

test('an exclusion undone from another terminal takes the offer with it', async () => {
  // Nothing local ran at all: the capture came back `pending` on the next
  // sweep. The offer is derived from the capture's own state precisely so a
  // route this screen never took cannot leave it standing.
  const server = mockServer([capture({ capture_id: 'c1', index_in_batch: 1 })]);
  const { result } = await renderReview();

  await act(async () => result.current.requestExclude('c1'));
  await waitFor(() => expect(result.current.excludeUndo).not.toBeNull());

  await act(async () => {
    server.setStored('c1', { review_status: 'adopted' });
    await result.current.reviewSave.invalidateList();
  });

  await waitFor(() => expect(result.current.excludeUndo).toBeNull());

  // Nothing local cleared the memo here — only the guard hid it. So this is
  // where the write itself has to refuse: firing the undo anyway must not send
  // `pending` over the adoption that arrived while the offer was on screen.
  const before = server.reviewCalls.length;
  await act(async () => result.current.undoExclude());
  expect(server.reviewCalls).toHaveLength(before);
  expect(
    result.current.rows.find((r) => r.captureId === 'c1')!.effectiveReviewStatus,
  ).toBe('adopted');
});
