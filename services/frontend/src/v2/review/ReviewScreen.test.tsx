import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { useUiStore } from '../../store/uiStore';
import { setSplitMode } from '../captures/splitMode';
import { setFiltersCollapsed } from './filtersRail';
import { ReviewScreen } from './ReviewScreen';
import type { Capture } from '../../api/types';

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
}

/** Everything the Review screen touches: the capture list, the per-capture
 *  detail the inspection loads, config/options, and the delete/review calls. */
function mockApi(initial: Capture[], options: ApiOptions = {}) {
  let items = initial.map((c) => ({ ...c }));
  const deleteCalls: { captureId: string; body: Record<string, unknown> }[] = [];
  const reviewCalls: { captureId: string; body: Record<string, unknown> }[] = [];

  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {};

    if (method === 'PATCH' && url.includes('/review')) {
      if (options.reviewError) {
        return Promise.resolve(
          jsonResponse(
            { error: { code: options.reviewError.code, message: options.reviewError.message } },
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
      return Promise.resolve(jsonResponse(next));
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

    const detail = url.match(/\/captures\/([^/?]+)$/);
    if (method === 'GET' && detail) {
      const id = decodeURIComponent(detail[1]!);
      const found = items.find((c) => c.capture_id === id);
      return Promise.resolve(jsonResponse(found ?? { ...capture({ capture_id: id }) }));
    }

    if (url.includes('/config/options')) return Promise.resolve(jsonResponse(CONFIG_OPTIONS));
    if (url.includes('/transfer/status'))
      return Promise.resolve(
        jsonResponse({ available: options.transferAvailable ?? false }),
      );
    if (url.includes('/retention'))
      return Promise.resolve(jsonResponse({ days: 0, candidates: [], total_bytes: 0 }));
    if (url.includes('/batches')) return Promise.resolve(jsonResponse({ items: [] }));
    if (url.includes('/captures'))
      return Promise.resolve(jsonResponse({ items: [...items], next_cursor: null }));
    return Promise.resolve(jsonResponse({}));
  });
  return { deleteCalls, reviewCalls };
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
    [capture({ capture_id: 'c1', run_id: 'run_1', index_in_batch: 1, quality: 'good' })],
    { reviewError: { status: 409, code: 'review_conflict', message: 'edited elsewhere' } },
  );
  renderWithClient(<ReviewScreen />);
  await waitFor(() => expect(screen.getByTestId('review-row-c1')).toBeInTheDocument());

  fireEvent.click(screen.getByTestId('review-final-quality'));

  const banner = await screen.findByTestId('review-conflict-banner');
  expect(banner.textContent).toMatch(/Reload/i);
  expect(screen.getByTestId('review-conflict-current').textContent).toMatch(/good/);
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
  await waitFor(() => expect(screen.getByTestId('review-exclude-c1')).toBeInTheDocument());

  fireEvent.click(screen.getByTestId('review-exclude-c1'));
  fireEvent.click(screen.getByTestId('review-confirm-exclude'));

  await waitFor(() =>
    expect(screen.getByTestId('review-discard-excluded')).toBeInTheDocument(),
  );
  // Excluding never removes anything.
  expect(api.deleteCalls).toHaveLength(0);
});

test('the detail panel shows the revision, which is what a conflict is about', async () => {
  mockApi([
    capture({ capture_id: 'c1', run_id: 'run_1', index_in_batch: 1, review_revision: 5 }),
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
  await waitFor(() => expect(screen.getByTestId('review-decision-bar')).toBeInTheDocument());
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
  expect(await screen.findByTestId('review-mark-ok')).toHaveTextContent('Mark OK — include');
});
