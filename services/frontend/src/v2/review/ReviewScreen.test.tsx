// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { useUiStore } from '../../store/uiStore';
import { setSplitMode } from '../captures/splitMode';
import { setFiltersCollapsed } from './filtersRail';
import { ReviewScreen } from './ReviewScreen';
import type { BatchSummary, Capture } from '../../api/types';
import { expectScreenHeadingOutline } from '../../test/headingOutline';

const FILTERS_KEY = 'kairos.v2.review.filtersCollapsed.v1';

const CONFIG_OPTIONS = {
  active_robot: 'airoa_hsr',
  robots: [],
  aspects: {
    recording: { active: 'default', options: [] },
    stream: { active: 'default', options: [] },
    validation: { active: 'default', options: [] },
    validators: { active: 'default', options: [] },
  },
};

function capture(partial: Partial<Capture> & { capture_id: string }): Capture {
  return {
    state: 'completed',
    review_status: 'pending',
    review_revision: 0,
    replica: { instance_id: 'inst', state: 'present_verified' },
    digest_state: 'complete',
    topics: [],
    ...partial,
  };
}

interface ApiOptions {
  reviewError?: { status: number; code: string; message: string };
  deleteError?: {
    status: number;
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  transferAvailable?: boolean;
  /** When true, every capture page reports another page after it, so the sweep
   *  ends at the client's own MAX_PAGES cap — the real truncation path, not a
   *  faked flag. */
  capturesNeverEnd?: boolean;
  /** Hold every review save open. The write still happens on ARRIVAL (a real
   *  server serialises); only the answer waits for `releaseReviews()`, and that
   *  wait is the window a second click lands in. */
  holdReviews?: boolean;
  /** Every POST /jobs is lost on the way out, as a dead connection loses it —
   *  a rejected fetch, not an error response. */
  jobsUnreachable?: boolean;
  batches?: BatchSummary[];
  batchesError?: boolean;
}

/** Everything the Review screen touches: the capture list, the per-capture
 *  detail the inspection loads, config/options, and the delete/review calls.
 *
 *  No compare-and-swap here either: `reviewError` injects the refusal rather
 *  than `base_revision` earning it, so the conflict tests below pin what the
 *  SCREEN does with a 409, not that a 409 would arrive. The natural refusal —
 *  a real second actor saving first — is `e2e/tests/02-review.spec.ts`
 *  (§13-2). Same note on `mockServer` in useReviewState.test.tsx. */
function mockApi(initial: Capture[], options: ApiOptions = {}) {
  let items = initial.map((c) => ({ ...c }));
  const deleteCalls: { captureId: string; body: Record<string, unknown> }[] = [];
  const reviewCalls: { captureId: string; body: Record<string, unknown> }[] = [];
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

    if (method === 'PATCH' && url.includes('/review')) {
      if (options.reviewError) {
        return answer(
          jsonResponse(
            {
              error: {
                code: options.reviewError.code,
                message: options.reviewError.message,
              },
            },
            options.reviewError.status,
          ),
        );
      }
      const id = decodeURIComponent(url.match(/\/captures\/([^/?]+)\/review/)![1]!);
      reviewCalls.push({ captureId: id, body });
      const idx = items.findIndex((c) => c.capture_id === id);
      const next = {
        ...items[idx]!,
        ...(body as Partial<Capture>),
        review_revision: items[idx]!.review_revision + 1,
      } as Capture;
      items[idx] = next;
      return answer(jsonResponse(next));
    }

    const del = url.match(/\/captures\/([^/?]+)\/delete/);
    if (method === 'POST' && del) {
      const id = decodeURIComponent(del[1]!);
      deleteCalls.push({ captureId: id, body });
      if (options.deleteError) {
        return Promise.resolve(
          jsonResponse(
            {
              error: {
                code: options.deleteError.code,
                message: options.deleteError.message,
                details: options.deleteError.details,
              },
            },
            options.deleteError.status,
          ),
        );
      }
      items = items.filter((c) => c.capture_id !== id);
      return Promise.resolve(jsonResponse({}, 200));
    }

    if (method === 'POST' && url.endsWith('/jobs') && options.jobsUnreachable) {
      return Promise.reject(new TypeError('Failed to fetch'));
    }

    if (method === 'POST' && url.endsWith('/captures/search')) {
      return Promise.resolve(
        jsonResponse({
          items,
          next_cursor: options.capturesNeverEnd ? 'more' : null,
          total: items.length,
          facets: {},
        }),
      );
    }

    const detail = url.match(/\/captures\/([^/?]+)$/);
    if (method === 'GET' && detail) {
      const id = decodeURIComponent(detail[1]!);
      const found = items.find((c) => c.capture_id === id);
      return Promise.resolve(jsonResponse(found ?? { ...capture({ capture_id: id }) }));
    }

    if (url.includes('/config/options'))
      return Promise.resolve(jsonResponse(CONFIG_OPTIONS));
    if (url.includes('/transfer/status'))
      return Promise.resolve(
        jsonResponse({ available: options.transferAvailable ?? false }),
      );
    if (url.includes('/retention'))
      return Promise.resolve(jsonResponse({ days: 0, candidates: [], total_bytes: 0 }));
    if (url.includes('/batches')) {
      if (options.batchesError)
        return Promise.reject(new TypeError('Batch service unavailable'));
      return Promise.resolve(jsonResponse({ items: options.batches ?? [] }));
    }
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
    deleteCalls,
    reviewCalls,
    /** Answer every held review save, oldest first. */
    releaseReviews: () => heldReviews.splice(0).forEach((r) => r()),
  };
}

beforeEach(() => {
  setApiBase('/api/v1');
  useUiStore.setState({ activeTab: '', pendingRun: null });
  setFiltersCollapsed(false);
  setSplitMode(false);
  window.localStorage.removeItem(FILTERS_KEY);
});
afterEach(() => {
  vi.restoreAllMocks();
  setSplitMode(false);
  setFiltersCollapsed(false);
  window.localStorage.removeItem(FILTERS_KEY);
});

test('rows render with an availability chip stating where the bytes are', async () => {
  mockApi([
    capture({ capture_id: 'c1', run_id: 'run_1', index_in_batch: 1 }),
    capture({
      capture_id: 'c2',
      run_id: 'run_2',
      index_in_batch: 2,
      replica: { instance_id: 'inst', state: 'present_unverified' },
      digest_state: 'pending',
    }),
  ]);
  renderWithClient(<ReviewScreen />);

  await waitFor(() => expect(screen.getByTestId('review-row-c1')).toBeInTheDocument());
  expect(screen.getByTestId('review-availability-c1')).toHaveAttribute(
    'data-availability',
    'verified',
  );
  // A digest still running is "verifying", never borrowed as verified (§9-4).
  expect(screen.getByTestId('review-availability-c2')).toHaveAttribute(
    'data-availability',
    'verifying',
  );
});

test('the right detail shows the recorded condition immediately below Task', async () => {
  mockApi(
    [
      capture({
        capture_id: 'c1',
        run_id: 'run_1',
        index_in_batch: 1,
        batch_id: 'batch-1',
        task: 'Pick and Place',
        collection_context: {
          batch_id: 'batch-1',
          batch_seq: 1,
          project_id: null,
          task_id: null,
          condition_id: null,
          project: 'Manipulation',
          task: 'Pick and Place',
          condition: 'Recorded left bin',
          robot: null,
          operator: 'op_a',
        },
      }),
    ],
    {
      batches: [
        {
          batch_id: 'batch-1',
          project: 'Manipulation',
          task: 'Pick and Place',
          condition: 'Current right bin',
          operator: 'op_a',
          target_episodes: 30,
          status: 'completed',
          episode_count: 1,
        },
      ],
    },
  );
  renderWithClient(<ReviewScreen />);

  const inspection = await screen.findByTestId('review-inspection');
  expect(screen.getByTestId('review-condition')).toHaveTextContent('Recorded left bin');
  const labels = Array.from(inspection.querySelectorAll('dt')).map((node) =>
    node.textContent?.trim(),
  );
  expect(labels.indexOf('Condition')).toBe(labels.indexOf('Task') + 1);
});

test('the detail calls an explicit snapshot condition null Not recorded', async () => {
  mockApi(
    [
      capture({
        capture_id: 'c1',
        batch_id: 'batch-1',
        collection_context: {
          batch_id: 'batch-1',
          batch_seq: 1,
          project_id: null,
          task_id: null,
          condition_id: null,
          project: null,
          task: null,
          condition: null,
          robot: null,
          operator: null,
        },
      }),
    ],
    {
      batches: [
        {
          batch_id: 'batch-1',
          project: null,
          task: null,
          condition: 'Current condition must not replace history',
          operator: null,
          target_episodes: 30,
          status: 'completed',
          episode_count: 1,
        },
      ],
    },
  );
  renderWithClient(<ReviewScreen />);

  expect(await screen.findByTestId('review-condition')).toHaveTextContent(
    'Not recorded',
  );
});

test('a legacy capture says Unavailable when its Batch condition cannot be loaded', async () => {
  mockApi([capture({ capture_id: 'c1', batch_id: 'batch-1' })], { batchesError: true });
  renderWithClient(<ReviewScreen />);

  await waitFor(() =>
    expect(screen.getByTestId('review-condition')).toHaveTextContent('Unavailable'),
  );
});

test('a capture with no local copy renders normally and explains itself', async () => {
  // Split deploy, review-before-bytes: a normal state, not an error (§12).
  mockApi([
    capture({ capture_id: 'c1', run_id: 'run_1', index_in_batch: 1, replica: null }),
  ]);
  renderWithClient(<ReviewScreen />);

  await waitFor(() => expect(screen.getByTestId('review-row-c1')).toBeInTheDocument());
  expect(screen.getByTestId('review-availability-c1')).toHaveAttribute(
    'data-availability',
    'awaiting_transfer',
  );
  const panel = await screen.findByTestId('review-no-local-copy');
  expect(panel).toHaveAttribute('data-availability', 'awaiting_transfer');
  expect(panel.textContent).toMatch(/expected, not a failure/i);
});

test('Discard and Delete are different dialogs with different obligations', async () => {
  mockApi([
    capture({
      capture_id: 'c1',
      run_id: 'run_1',
      index_in_batch: 1,
      review_status: 'excluded',
      bytes: 2_000_000,
    }),
  ]);
  renderWithClient(<ReviewScreen />);
  await waitFor(() =>
    expect(screen.getByTestId('review-discard-excluded')).toBeInTheDocument(),
  );

  fireEvent.click(screen.getByTestId('review-discard-excluded'));
  const discard = screen.getByTestId('discard-dialog');
  expect(screen.queryByTestId('delete-dialog')).toBeNull();
  // The discard is obliged to state irreversibility, the scope, and to require
  // a reason before it will run (§12).
  expect(screen.getByTestId('discard-irreversible').textContent).toMatch(
    /cannot be undone/i,
  );
  expect(screen.getByTestId('discard-scope').textContent).toMatch(/1 recording/);
  expect(screen.getByTestId('discard-scope').textContent).toMatch(/2\.0 MB/);
  // Nothing chosen yet, so there is no reason to record and Discard is refused.
  expect(screen.getByTestId('discard-confirm')).toBeDisabled();
  fireEvent.click(screen.getByTestId('discard-reason-false_start'));
  expect(screen.getByTestId('discard-confirm')).toBeEnabled();
  expect(discard).toBeInTheDocument();

  fireEvent.click(screen.getByTestId('discard-cancel'));
  fireEvent.click(screen.getByTestId('review-delete-excluded'));
  // The delete is a separate dialog, and its reason is optional.
  expect(screen.getByTestId('delete-dialog')).toBeInTheDocument();
  expect(screen.queryByTestId('discard-dialog')).toBeNull();
  expect(screen.getByTestId('delete-confirm')).toBeEnabled();
});

test('the discard dialog admits a robot-side copy may survive on a split deploy', async () => {
  mockApi(
    [
      capture({
        capture_id: 'c1',
        run_id: 'run_1',
        index_in_batch: 1,
        review_status: 'excluded',
      }),
    ],
    { transferAvailable: true },
  );
  renderWithClient(<ReviewScreen />);
  // Split mode is derived from the transfer channel's probe, so wait for the
  // control that only exists once it has resolved before opening the dialog.
  await waitFor(() =>
    expect(screen.getByTestId('review-transfer-all')).toBeInTheDocument(),
  );

  fireEvent.click(screen.getByTestId('review-discard-excluded'));
  // §0/§12: a discard removes only this machine's copy, and the UI says so
  // unprompted rather than letting the operator assume otherwise.
  expect(screen.getByTestId('discard-split-note').textContent).toMatch(
    /may still exist on the robot/i,
  );
});

test('confirming a discard sends kind discard with the typed reason', async () => {
  const api = mockApi([
    capture({
      capture_id: 'c1',
      run_id: 'run_1',
      index_in_batch: 1,
      review_status: 'excluded',
    }),
  ]);
  renderWithClient(<ReviewScreen />);
  await waitFor(() =>
    expect(screen.getByTestId('review-discard-excluded')).toBeInTheDocument(),
  );

  fireEvent.click(screen.getByTestId('review-discard-excluded'));
  fireEvent.click(screen.getByTestId('discard-reason-other'));
  fireEvent.change(screen.getByTestId('discard-reason'), {
    target: { value: 'bad calibration' },
  });
  fireEvent.click(screen.getByTestId('discard-confirm'));

  await waitFor(() => expect(api.deleteCalls).toHaveLength(1));
  expect(api.deleteCalls[0]).toEqual({
    captureId: 'c1',
    body: { kind: 'discard', reason: 'bad calibration' },
  });
});

test('a 409 capture_busy names the job holding the lease inside the dialog', async () => {
  mockApi(
    [
      capture({
        capture_id: 'c1',
        run_id: 'run_1',
        index_in_batch: 1,
        review_status: 'excluded',
      }),
    ],
    {
      deleteError: {
        status: 409,
        code: 'capture_busy',
        message: 'a job holds this capture',
        details: { lease_owner: 'digest-job-7' },
      },
    },
  );
  renderWithClient(<ReviewScreen />);
  await waitFor(() =>
    expect(screen.getByTestId('review-delete-excluded')).toBeInTheDocument(),
  );

  fireEvent.click(screen.getByTestId('review-delete-excluded'));
  fireEvent.click(screen.getByTestId('delete-confirm'));

  const failures = await screen.findByTestId('delete-failures');
  expect(failures.textContent).toMatch(/digest-job-7/);
});

test('a refused review save raises the conflict banner with what is stored now', async () => {
  mockApi(
    [
      capture({
        capture_id: 'c1',
        run_id: 'run_1',
        index_in_batch: 1,
        quality: 'good',
      }),
    ],
    {
      reviewError: {
        status: 409,
        code: 'review_conflict',
        message: 'edited elsewhere',
      },
    },
  );
  renderWithClient(<ReviewScreen />);
  await waitFor(() => expect(screen.getByTestId('review-row-c1')).toBeInTheDocument());

  fireEvent.click(screen.getByTestId('review-final-quality'));

  const banner = await screen.findByTestId('review-conflict-banner');
  expect(banner.textContent).toMatch(/Reload/i);
  expect(screen.getByTestId('review-conflict-current').textContent).toMatch(/Good/);
  fireEvent.click(screen.getByTestId('review-conflict-dismiss'));
  await waitFor(() =>
    expect(screen.queryByTestId('review-conflict-banner')).toBeNull(),
  );
});

test('a sidecar write failure is stated explicitly and must be dismissed', async () => {
  mockApi([capture({ capture_id: 'c1', run_id: 'run_1', index_in_batch: 1 })], {
    reviewError: {
      status: 500,
      code: 'review_sidecar_write_failed',
      message: 'disk full',
    },
  });
  renderWithClient(<ReviewScreen />);
  await waitFor(() => expect(screen.getByTestId('review-row-c1')).toBeInTheDocument());

  fireEvent.click(screen.getByTestId('review-final-quality'));

  const failure = await screen.findByTestId('review-save-failure');
  expect(failure).toHaveAttribute('data-error-code', 'review_sidecar_write_failed');
  // §12: never a passing note — the operator must see that nothing was saved.
  expect(failure.textContent).toMatch(/Not saved/);
  expect(failure.textContent).toMatch(/NOTHING was saved/);
});

test('excluding a row is offered as a label, separately from any removal', async () => {
  const api = mockApi([
    capture({ capture_id: 'c1', run_id: 'run_1', index_in_batch: 1 }),
  ]);
  renderWithClient(<ReviewScreen />);
  await waitFor(() =>
    expect(screen.getByTestId('review-exclude-c1')).toBeInTheDocument(),
  );

  // CHANGED with #12: no confirmation step. Excluding keeps every byte and is
  // undoable from the toolbar, so the click is the action.
  fireEvent.click(screen.getByTestId('review-exclude-c1'));

  await waitFor(() =>
    expect(screen.getByTestId('review-discard-excluded')).toBeInTheDocument(),
  );
  // Excluding never removes anything.
  expect(api.deleteCalls).toHaveLength(0);
});

test('the excluded row is gone from the table, and the undo for it is not', async () => {
  // The two halves of the same fact: the default view hides excluded rows, so
  // an undo attached to the ROW would be behind "Show excluded" at exactly the
  // moment the operator wants their mis-click back.
  mockApi([capture({ capture_id: 'c1', run_id: 'run_1', index_in_batch: 1 })]);
  renderWithClient(<ReviewScreen />);
  await waitFor(() =>
    expect(screen.getByTestId('review-exclude-c1')).toBeInTheDocument(),
  );

  fireEvent.click(screen.getByTestId('review-exclude-c1'));

  const undo = await screen.findByTestId('review-exclude-undo');
  expect(screen.queryByTestId('review-row-c1')).not.toBeInTheDocument();
  expect(undo).toHaveTextContent('Episode #1');
  expect(undo).toHaveTextContent('the recording is kept');

  // Announced, and named. The band is the durable half of the announcement —
  // the toast that fires with it is gone in seconds — and the buttons carry
  // their subject, because the span naming the episode is not associated with
  // them: on their own they are one of however many "Undo"s on the page.
  expect(undo).toHaveAttribute('role', 'status');
  expect(screen.getByRole('button', { name: 'Undo excluding Episode #1' })).toBe(
    screen.getByTestId('review-exclude-undo-btn'),
  );
  expect(
    screen.getByRole('button', { name: 'Dismiss — Episode #1 stays excluded' }),
  ).toBe(screen.getByTestId('review-exclude-undo-dismiss'));

  // Undo puts it back in one click, and the offer goes with it.
  fireEvent.click(screen.getByTestId('review-exclude-undo-btn'));
  await waitFor(() => expect(screen.getByTestId('review-row-c1')).toBeInTheDocument());
  expect(screen.queryByTestId('review-exclude-undo')).not.toBeInTheDocument();
});

test('the undo offer is dismissible, and dismissing it changes nothing else', async () => {
  const api = mockApi([
    capture({ capture_id: 'c1', run_id: 'run_1', index_in_batch: 1 }),
  ]);
  renderWithClient(<ReviewScreen />);
  await waitFor(() =>
    expect(screen.getByTestId('review-exclude-c1')).toBeInTheDocument(),
  );

  fireEvent.click(screen.getByTestId('review-exclude-c1'));
  await screen.findByTestId('review-exclude-undo');
  fireEvent.click(screen.getByTestId('review-exclude-undo-dismiss'));

  await waitFor(() =>
    expect(screen.queryByTestId('review-exclude-undo')).not.toBeInTheDocument(),
  );
  // Dismissing is not undoing: one save happened, and it stands.
  expect(api.reviewCalls).toHaveLength(1);
  expect(screen.queryByTestId('review-row-c1')).not.toBeInTheDocument();
});

test('the detail panel shows the revision, which is what a conflict is about', async () => {
  mockApi([
    capture({
      capture_id: 'c1',
      run_id: 'run_1',
      index_in_batch: 1,
      review_revision: 5,
    }),
  ]);
  renderWithClient(<ReviewScreen />);
  const revision = await screen.findByTestId('review-revision');
  expect(revision.textContent).toBe('revision 5');
});

// ACCEPT blocker (qa-ui's release verdict): the two screens pointed at each
// other. Review's READY lane is the lane that needs no attention, so it offered
// nothing but Exclude, while the Datasets rail refuses any capture that is not
// adopted — a GOOD take could never enter a training set through the UI, and
// only a mediocre one (which passes through NEEDS CHECK, where "Mark OK"
// adopts) could. Every capture recorded before this is in exactly that state.
test('a READY capture that was never adopted can be adopted from its detail', async () => {
  const api = mockApi([
    capture({
      capture_id: 'c1',
      run_id: 'run_1',
      index_in_batch: 1,
      quality: 'good',
      task_result: 'success',
      review_status: 'pending',
      review_revision: 5,
    }),
  ]);
  renderWithClient(<ReviewScreen />);

  const adopt = await screen.findByTestId('review-mark-ok');
  // READY vocabulary: this is not an exception being resolved, it is the
  // adoption Datasets asks for.
  expect(adopt).toHaveTextContent('Adopt — include in datasets');

  fireEvent.click(adopt);

  await waitFor(() => expect(api.reviewCalls).toHaveLength(1));
  expect(api.reviewCalls[0]!.captureId).toBe('c1');
  // The same compare-and-swap every other decision uses — an adopt made against
  // a stale revision must be refused like any other.
  expect(api.reviewCalls[0]!.body).toMatchObject({
    review_status: 'adopted',
    base_revision: 5,
  });

  // Once adopted there is nothing left to do here, so the control goes.
  await waitFor(() => expect(screen.queryByTestId('review-mark-ok')).toBeNull());
});

test('an adopted capture offers no adopt control at all', async () => {
  mockApi([
    capture({
      capture_id: 'c1',
      run_id: 'run_1',
      index_in_batch: 1,
      quality: 'good',
      review_status: 'adopted',
      review_revision: 2,
    }),
  ]);
  renderWithClient(<ReviewScreen />);
  await waitFor(() =>
    expect(screen.getByTestId('review-decision-bar')).toBeInTheDocument(),
  );
  expect(screen.queryByTestId('review-mark-ok')).toBeNull();
});

test('a NEEDS CHECK exception keeps its own wording', async () => {
  mockApi([
    capture({
      capture_id: 'c1',
      run_id: 'run_1',
      index_in_batch: 1,
      quality: 'needs_review',
      review_status: 'pending',
      review_revision: 1,
    }),
  ]);
  renderWithClient(<ReviewScreen />);
  // Same control, same server effect; the exception lane still reads as
  // resolving an exception rather than as a dataset step.
  expect(await screen.findByTestId('review-mark-ok')).toHaveTextContent(
    'Mark OK — include',
  );
});

test('a batch return that fails says so where the operator will still see it', async () => {
  mockApi(
    [
      capture({ capture_id: 'c1', run_id: 'run_1', batch_id: 'b1', index_in_batch: 1 }),
      capture({
        capture_id: 'c2',
        run_id: 'run_2',
        batch_id: 'b1',
        index_in_batch: 2,
        review_status: 'excluded',
      }),
      capture({
        capture_id: 'c3',
        run_id: 'run_3',
        batch_id: 'b1',
        index_in_batch: 3,
        review_status: 'excluded',
      }),
    ],
    {
      reviewError: {
        status: 500,
        code: 'review_sidecar_write_failed',
        message: 'record.json could not be written',
      },
    },
  );
  renderWithClient(<ReviewScreen />);

  await waitFor(() => expect(screen.getByTestId('review-row-c1')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('review-batch-chip-c1'));
  await waitFor(() =>
    expect(screen.getByTestId('review-return-batch')).toBeInTheDocument(),
  );
  fireEvent.click(screen.getByTestId('review-return-batch'));

  // The toast is gone in seconds and both episodes stay excluded, which hides
  // them from the default table — so the standing notice is the only thing
  // that keeps the failure in front of the operator.
  await waitFor(() =>
    expect(screen.getByTestId('review-return-batch-failures')).toHaveTextContent(
      '2 still excluded — return failed',
    ),
  );
  // The count alone would let the reasons be dropped on the way to the DOM.
  // Both episodes are named, each with why it stayed behind.
  const title = screen
    .getByTestId('review-return-batch-failures')
    .getAttribute('title');
  expect(title).toContain('c2');
  expect(title).toContain('c3');
  expect(title).toContain('record.json');
});

// ---- one save at a time, seen from the screen ----------------------------

test('a second decision taken while the save is in flight goes nowhere, visibly', async () => {
  // Mark OK renders only while the capture is not adopted, and the optimistic
  // overlay adopts it the instant it is clicked — so the button unmounts and
  // EXCLUDE, its `flex-1` neighbour, slides into the slot the pointer is
  // already over. The operator's second click is therefore not a repeat of
  // their decision but the opposite one, spending a revision already spent.
  const api = mockApi(
    [capture({ capture_id: 'c1', run_id: 'run_1', index_in_batch: 1 })],
    {
      holdReviews: true,
    },
  );
  renderWithClient(<ReviewScreen />);
  await waitFor(() => expect(screen.getByTestId('review-mark-ok')).toBeInTheDocument());

  const bar = screen.getByTestId('review-decision-bar');
  expect(bar.querySelector('button')).toHaveAttribute('data-testid', 'review-mark-ok');
  expect(screen.getByTestId('review-mark-ok')).toBeEnabled();

  fireEvent.click(screen.getByTestId('review-mark-ok'));
  // Positive control: the click really did put a save on the wire. The fetch
  // goes out in a microtask, so this has to be awaited.
  await waitFor(() => expect(api.reviewCalls).toHaveLength(1));

  // The slot the pointer is over now holds a different decision.
  const underCursor = bar.querySelector('button')!;
  expect(underCursor).toHaveAttribute('data-testid', 'review-decision-exclude');
  // It is refused, and the screen says why instead of swallowing the click.
  expect(underCursor).toBeDisabled();
  expect(screen.getByTestId('review-saving')).toBeInTheDocument();

  fireEvent.click(underCursor);
  await Promise.resolve();
  expect(api.reviewCalls).toHaveLength(1);

  // The answer arrives: the notice goes, the controls come back, and the
  // operator was never told a stranger had edited their capture.
  await act(async () => {
    api.releaseReviews();
  });
  await waitFor(() => expect(screen.queryByTestId('review-saving')).toBeNull());
  expect(screen.queryByTestId('review-conflict-banner')).toBeNull();
  await waitFor(() =>
    expect(screen.getByTestId('review-decision-exclude')).toBeEnabled(),
  );
});

test('double-clicking Final quality saves once and never blames the operator', async () => {
  // The tile's own tooltip asks for repeat clicks ("Good -> Needs review ->
  // Not usable"), so two fast clicks are the intended route to the third
  // value, not operator error.
  const api = mockApi(
    [
      capture({
        capture_id: 'c1',
        run_id: 'run_1',
        index_in_batch: 1,
        quality: 'good',
      }),
    ],
    { holdReviews: true },
  );
  renderWithClient(<ReviewScreen />);
  await waitFor(() =>
    expect(screen.getByTestId('review-final-quality')).toBeInTheDocument(),
  );

  fireEvent.click(screen.getByTestId('review-final-quality'));
  await waitFor(() => expect(api.reviewCalls).toHaveLength(1));
  expect(api.reviewCalls[0]!.body).toMatchObject({
    base_revision: 0,
    quality: 'needs_review',
  });
  expect(screen.getByTestId('review-final-quality')).toHaveAttribute(
    'aria-disabled',
    'true',
  );

  fireEvent.click(screen.getByTestId('review-final-quality'));
  await Promise.resolve();
  expect(api.reviewCalls).toHaveLength(1);
  // The value the in-flight save is writing is still on screen.
  expect(screen.getByTestId('review-final-quality').textContent).toContain(
    'Needs review',
  );

  await act(async () => {
    api.releaseReviews();
  });
  // Neither of the two things the race used to produce: no accusation that
  // someone else saved first, and no silently dropped second step.
  expect(screen.queryByTestId('review-conflict-banner')).toBeNull();
  await waitFor(() =>
    expect(screen.getByTestId('review-final-quality')).toHaveAttribute(
      'aria-disabled',
      'false',
    ),
  );
  // The third value is still reachable. It costs one round trip, and the
  // revision it spends is the live one.
  fireEvent.click(screen.getByTestId('review-final-quality'));
  await waitFor(() => expect(api.reviewCalls).toHaveLength(2));
  expect(api.reviewCalls[1]!.body).toMatchObject({
    base_revision: 1,
    quality: 'not_usable',
  });
});

test('a conflict raised by another terminal is still reported', async () => {
  // The half that must not regress, asserted from the screen: refusing the
  // operator's own second click must not silence the warning the
  // compare-and-swap exists to give.
  mockApi([capture({ capture_id: 'c1', run_id: 'run_1', index_in_batch: 1 })], {
    reviewError: {
      status: 409,
      code: 'review_conflict',
      message: 'The review changed since you loaded it.',
    },
  });
  renderWithClient(<ReviewScreen />);
  await waitFor(() => expect(screen.getByTestId('review-mark-ok')).toBeInTheDocument());

  fireEvent.click(screen.getByTestId('review-mark-ok'));
  const banner = await screen.findByTestId('review-conflict-banner');
  expect(banner.textContent).toMatch(
    /Someone else saved a review for this capture first/,
  );
  // And the screen is usable afterwards: the notice is gone, so the operator
  // can reload and re-apply rather than facing a permanently frozen bar.
  await waitFor(() => expect(screen.queryByTestId('review-saving')).toBeNull());
});

test('a banner that outlives the selection says which episode it is about', async () => {
  // It has to, now that it does outlive it. A warning the operator cannot
  // attribute to a capture is not a smaller version of the wiped banner — it
  // is a different way of being unusable, and swapping one for the other is
  // not a fix.
  mockApi(
    [
      capture({ capture_id: 'c1', run_id: 'run_1', index_in_batch: 1 }),
      capture({ capture_id: 'c2', run_id: 'run_2', index_in_batch: 2 }),
    ],
    {
      reviewError: {
        status: 409,
        code: 'review_conflict',
        message: 'The review changed since you loaded it.',
      },
    },
  );
  renderWithClient(<ReviewScreen />);
  await waitFor(() => expect(screen.getByTestId('review-row-c1')).toBeInTheDocument());

  fireEvent.click(screen.getByTestId('review-row-c1'));
  fireEvent.click(screen.getByTestId('review-mark-ok'));
  await screen.findByTestId('review-conflict-banner');
  expect(screen.getByTestId('review-conflict-subject').textContent).toBe('Episode #1');

  // The operator moves to another row. The banner still names the episode it
  // is about, not the one they are now looking at.
  fireEvent.click(screen.getByTestId('review-row-c2'));
  await waitFor(() =>
    expect(screen.getByTestId('review-detail-header').textContent).toContain('#2'),
  );
  expect(screen.getByTestId('review-conflict-banner')).toBeInTheDocument();
  expect(screen.getByTestId('review-conflict-subject').textContent).toBe('Episode #1');
});

test('the "nothing was saved" notice names its episode too', async () => {
  // §12's loudest failure carries the same duty as the conflict: it now
  // outlives the selection, so it has to say what it is about.
  mockApi(
    [
      capture({ capture_id: 'c1', run_id: 'run_1', index_in_batch: 1 }),
      capture({ capture_id: 'c2', run_id: 'run_2', index_in_batch: 2 }),
    ],
    {
      reviewError: {
        status: 500,
        code: 'review_sidecar_write_failed',
        message: 'could not write record.json',
      },
    },
  );
  renderWithClient(<ReviewScreen />);
  await waitFor(() => expect(screen.getByTestId('review-row-c1')).toBeInTheDocument());

  fireEvent.click(screen.getByTestId('review-row-c1'));
  fireEvent.click(screen.getByTestId('review-mark-ok'));
  await screen.findByTestId('review-save-failure');
  expect(screen.getByTestId('review-save-failure-subject').textContent).toBe(
    'Episode #1',
  );
});

// ---- the catalog sweep's own limit ---------------------------------------
// "N shown" and the lane tallies beside it are counts over one cursor sweep
// that gives up after MAX_PAGES. Where the list ends is where an operator
// concludes there is nothing more, so that is where the caveat belongs (E-27).

test('a catalog too big for one sweep says so where the list ends', async () => {
  mockApi([capture({ capture_id: 'c1', run_id: 'run_1', index_in_batch: 1 })], {
    capturesNeverEnd: true,
  });
  renderWithClient(<ReviewScreen />);

  const note = await screen.findByTestId('catalog-truncated', undefined, {
    timeout: 10000,
  });
  expect(note).toHaveTextContent(/not the whole catalog|more recordings than/i);
  // It says what to do about it rather than only that something is wrong.
  expect(note).toHaveTextContent(/search/i);
});

test('a catalog that fits reports nothing — the note is not decoration', async () => {
  mockApi([capture({ capture_id: 'c1', run_id: 'run_1', index_in_batch: 1 })]);
  renderWithClient(<ReviewScreen />);

  await screen.findByTestId('review-row-c1');
  expect(screen.queryByTestId('catalog-truncated')).not.toBeInTheDocument();
});

// ---- accessible names (#10) ----------------------------------------------
// Both controls carried their purpose visually only: the search in a
// placeholder, the operator filter in a caption sitting above it that nothing
// tied to the field. Queried by name here on purpose — a testid query would go
// on passing with the association removed again.

test('the episode search and the operator filter both have accessible names', async () => {
  mockApi([
    capture({ capture_id: 'c1', run_id: 'run_1', index_in_batch: 1, operator: 'op_a' }),
  ]);
  renderWithClient(<ReviewScreen />);
  await screen.findByTestId('review-row-c1');

  expect(screen.getByRole('textbox', { name: 'Search episodes' })).toBe(
    screen.getByTestId('review-search'),
  );
  // A real <label for>, so clicking the caption moves focus into the select.
  expect(screen.getByRole('combobox', { name: 'Operator' })).toBe(
    screen.getByTestId('review-operator-filter'),
  );
});

// N1: the detail panel rendered <CaptureInspection captureId={…}/> with no key,
// so selecting another episode re-rendered the SAME instance with a new id.
// Everything that panel holds is per-capture — a running job id, a frozen
// submission error, and the report snapshot a failed attempt compares against —
// and none of it belongs to the episode the operator switched to. A failed
// validation on one recording carried its note onto the next, where it
// described an attempt that never touched that recording.
test('a failed check does not follow the operator to the next episode', async () => {
  mockApi(
    [
      capture({ capture_id: 'c1', run_id: 'run_1', index_in_batch: 1 }),
      capture({ capture_id: 'c2', run_id: 'run_2', index_in_batch: 2 }),
    ],
    { jobsUnreachable: true },
  );
  renderWithClient(<ReviewScreen />);
  await waitFor(() => expect(screen.getByTestId('review-row-c1')).toBeInTheDocument());

  fireEvent.click(screen.getByTestId('review-row-c1'));
  fireEvent.click(await screen.findByTestId('review-run-validation'));
  await screen.findByTestId('review-validation-error');

  fireEvent.click(screen.getByTestId('review-row-c2'));
  await waitFor(() =>
    expect(screen.getByTestId('review-detail-header').textContent).toContain('#2'),
  );

  // Episode 2 was never asked to validate anything, so it has nothing to say
  // about a failed attempt — and above all must not claim a check "landed
  // after all" against a recording this attempt never touched.
  expect(screen.queryByTestId('review-validation-error')).toBeNull();
  expect(screen.queryByTestId('review-validation-error-stale')).toBeNull();
});

// #14 — heading structure. This screen must title itself exactly once and
// descend one heading level at a time, so a screen-reader user can navigate it
// by heading instead of reading it as one flat run of text.
test('titles itself with a single h1 and skips no heading level', async () => {
  renderWithClient(<ReviewScreen />);
  await expectScreenHeadingOutline('Review');
}, 20000);
