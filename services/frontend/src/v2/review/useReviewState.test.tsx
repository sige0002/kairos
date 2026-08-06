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
function mockServer(initial: Capture[], options: ServerOptions = {}) {
  let items = initial.map((c) => ({ ...c }));
  const reviewCalls: { captureId: string; body: Record<string, unknown> }[] = [];
  const deleteCalls: { captureId: string; body: Record<string, unknown> }[] = [];
  const pullCalls: string[] = [];
  const heldReviews: (() => void)[] = [];
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
      const err = options.reviewErrors?.[id];
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
      } as Capture;
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
    items: () => items,
    /** Answer every held review save, oldest first. */
    releaseReviews: () => heldReviews.splice(0).forEach((r) => r()),
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
    capture({ capture_id: 'c1', run_id: 'run_1', batch_id: 'b1', review_status: status }),
    capture({ capture_id: 'c2', run_id: 'run_2', batch_id: 'b1', review_status: status }),
    capture({ capture_id: 'c3', run_id: 'run_3', batch_id: 'b1', review_status: status }),
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
  const server = mockServer(batchOf3('excluded'), { reviewErrors: { c2: SIDECAR_500 } });
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
  const skipped = result.current.excludeBatchFailures.find((f) => f.captureId === 'c1')!;
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

// ---- the catalog sweep's own limit ---------------------------------------
// Review's rows, its lane counts and its bulk sets all come from one cursor
// sweep that gives up after MAX_PAGES. When it does, every one of those is a
// number about what was fetched, presented as a number about the catalog — so
// the state has to carry the fact, not just the rows (E-27).

test('a sweep that stops short of the end of the catalog is reported', async () => {
  mockServer([capture({ capture_id: 'c1' })], { capturesNeverEnd: true });
  const { result } = await renderReview();

  expect(result.current.catalogTruncated).toBe(true);
  // The rows it did fetch are still usable — this is a caveat, not an error.
  expect(result.current.rows.length).toBeGreaterThan(0);
});

test('a catalog that fits reports nothing — the flag is not decoration', async () => {
  mockServer([capture({ capture_id: 'c1' })]);
  const { result } = await renderReview();

  expect(result.current.catalogTruncated).toBe(false);
});
