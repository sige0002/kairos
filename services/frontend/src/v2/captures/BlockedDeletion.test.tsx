// Removing a capture that a job is holding (§7.1).
//
// What the operator hit: the delete came back "another job is working on this
// capture", and the only thing the dialog could offer was to wait — without
// saying what for, or how long. The lease is what refuses the removal, so the
// removal has to be able to reach it: the refusal now names its holders and
// offers to cancel them and try again.
//
// The retry is deliberately ONCE. A retry that lost to a job which started in
// the meantime would spin, and each turn of that loop cancels somebody's work.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { DeleteDialog } from './DeleteDialogs';
import {
  __resetCancelSettleMs,
  __setCancelSettleMs,
  useCaptureDeletion,
} from './useCaptureDeletion';
import type { CaptureListItem } from '../../api/types';

const CAP = 'cap-1';

const capture: CaptureListItem = {
  capture_id: CAP,
  run_id: 'run_20260807_120000',
  state: 'completed',
  review_status: 'pending',
  review_revision: 1,
  bytes: 1_000_000,
};

function busyBody(holders: { owner: string; expires_at: string }[]) {
  return {
    error: {
      code: 'capture_busy',
      message: `Another job is working on ${CAP}.`,
      details: {
        capture_id: CAP,
        holders,
        lease_owner: holders[0]?.owner,
        lease_expires_at: holders.at(-1)?.expires_at,
      },
    },
  };
}

const HOLDERS = [
  { owner: 'job:job-a', expires_at: '2026-08-07T12:34:56Z' },
  { owner: 'job:job-b', expires_at: '2026-08-07T12:35:10Z' },
];

/**
 * A server whose lease is held until the blocking jobs' WORK actually stops.
 *
 * Cancel of running work is a request (S1-1): the response is still `running`
 * with `cancel_requested`, the worker stops at its next checkpoint, and only a
 * later status poll observes `canceled` — which is also the observation that
 * releases that job's hold. `job-a` settles one status read late, so the flow
 * must genuinely wait it out rather than retry into a 409.
 *
 * `stayBusy` models the case the retry must not loop on: a NEW job takes the
 * capture between the cancel and the retry, so the second attempt is refused
 * too — by a different holder.
 */
function mockServer(opts: { stayBusy?: boolean; cancelFails?: string[] } = {}) {
  const cancels: string[] = [];
  const deletes: number[] = [];
  const statusReads: Record<string, number> = {};
  const cancelRequested = new Set<string>();
  // How many status reads after the cancel before the work reports canceled.
  const settleAfter: Record<string, number> = { 'job-a': 1, 'job-b': 0 };
  const held = new Set(HOLDERS.map((h) => h.owner));

  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();

    const cancel = url.match(/\/jobs\/([^/]+)\/cancel$/);
    if (cancel && method === 'POST') {
      const jobId = cancel[1]!;
      cancels.push(jobId);
      if (opts.cancelFails?.includes(jobId)) {
        return Promise.resolve(
          jsonResponse(
            { error: { code: 'job_not_cancellable', message: 'the runner is not answering' } },
            409,
          ),
        );
      }
      cancelRequested.add(jobId);
      // Still running: the work stops at its next checkpoint, not here.
      return Promise.resolve(
        jsonResponse({ job_id: jobId, state: 'running', cancel_requested: true }),
      );
    }

    const status = url.match(/\/jobs\/([^/]+)\/status$/);
    if (status && method === 'GET') {
      const jobId = status[1]!;
      const reads = (statusReads[jobId] = (statusReads[jobId] ?? 0) + 1);
      if (cancelRequested.has(jobId) && reads > (settleAfter[jobId] ?? 0)) {
        // The work is dead; observing that is what releases the hold.
        held.delete(`job:${jobId}`);
        return Promise.resolve(
          jsonResponse({ job_id: jobId, state: 'canceled', cancel_requested: true }),
        );
      }
      return Promise.resolve(
        jsonResponse({
          job_id: jobId,
          state: 'running',
          cancel_requested: cancelRequested.has(jobId),
        }),
      );
    }

    if (url.includes('/delete') && method === 'POST') {
      deletes.push(deletes.length + 1);
      if (held.size > 0 || opts.stayBusy) {
        return Promise.resolve(
          jsonResponse(
            // A second refusal names whoever holds it NOW.
            busyBody(
              held.size > 0
                ? HOLDERS.filter((h) => held.has(h.owner))
                : [{ owner: 'job:job-c', expires_at: '2026-08-07T12:40:00Z' }],
            ),
            409,
          ),
        );
      }
      return Promise.resolve(jsonResponse({ capture_id: CAP }));
    }
    return Promise.resolve(jsonResponse({}));
  });
  return { cancels, deletes, statusReads };
}

/** The dialog wired to the real hook, as both screens wire it. */
function Harness() {
  const deletion = useCaptureDeletion();
  return (
    <>
      <button type="button" data-testid="open" onClick={() => deletion.requestDelete(capture)}>
        open
      </button>
      <DeleteDialog
        open={deletion.kind === 'delete'}
        captures={deletion.targets}
        busy={deletion.busy}
        error={deletion.error}
        done={deletion.done}
        failures={deletion.failures}
        blockers={deletion.blockers}
        clearingBlockers={deletion.clearingBlockers}
        blockerFailures={deletion.blockerFailures}
        onClearBlockers={(reason) => void deletion.clearBlockersAndRetry(reason)}
        onCancel={deletion.cancel}
        onConfirm={(reason) => void deletion.confirm(reason)}
      />
    </>
  );
}

async function openAndAttemptDelete() {
  renderWithClient(<Harness />);
  fireEvent.click(screen.getByTestId('open'));
  fireEvent.click(await screen.findByTestId('delete-confirm'));
  return screen.findByTestId('delete-error');
}

beforeEach(() => {
  setApiBase('/api/v1');
  // Real budget semantics at a test cadence: the settle wait must still poll,
  // just not at 1 s per read.
  __setCancelSettleMs(2000, 5);
});
afterEach(() => {
  __resetCancelSettleMs();
  vi.restoreAllMocks();
  render(<div />);
});

test('a blocked removal names every job holding the capture', async () => {
  mockServer();
  const box = await openAndAttemptDelete();

  expect(box).toHaveAttribute('data-error-code', 'capture_busy');
  const holders = await screen.findByTestId('busy-holders');
  expect(holders).toHaveTextContent('Held by 2 jobs');
  // The job ids, with the `job:` prefix stripped — what a cancel takes.
  expect(holders).toHaveTextContent('job-a');
  expect(holders).toHaveTextContent('job-b');
  // §4: doing nothing is still an option, and it has a time on it. The LAST
  // holder to lapse is when the capture is actually free.
  expect(holders).toHaveTextContent(/Left alone, the hold lapses by/);
  // The button says what it costs.
  expect(screen.getByTestId('busy-cancel-retry')).toHaveTextContent(
    'Cancel those jobs and retry',
  );
  expect(holders).toHaveTextContent(/their work is lost, not paused/i);
});

test('cancelling the blockers retries the removal and it goes through', async () => {
  const server = mockServer();
  await openAndAttemptDelete();

  fireEvent.click(await screen.findByTestId('busy-cancel-retry'));

  // Every holder was cancelled, by job id...
  await waitFor(() => expect(server.cancels).toEqual(['job-a', 'job-b']));
  // ...and the removal was retried exactly once more (the first attempt + one).
  await waitFor(() => expect(server.deletes).toHaveLength(2));
  // It succeeded, so the dialog closes rather than holding a stale refusal.
  await waitFor(() => expect(screen.queryByTestId('delete-error')).toBeNull());
  // The retry genuinely WAITED for job-a's work to die (it settles one status
  // read late): the delete was not fired into a lease that was still held.
  expect(server.statusReads['job-a']).toBeGreaterThanOrEqual(2);
});

test('a retry that is blocked again updates the holders and stops there', async () => {
  // A different job took the capture between the cancel and the retry.
  const server = mockServer({ stayBusy: true });
  await openAndAttemptDelete();

  fireEvent.click(await screen.findByTestId('busy-cancel-retry'));

  await waitFor(() => expect(server.cancels).toEqual(['job-a', 'job-b']));
  // The new holder is shown...
  await waitFor(() =>
    expect(screen.getByTestId('busy-holders')).toHaveTextContent('job-c'),
  );
  expect(screen.getByTestId('busy-holders')).toHaveTextContent('Held by 1 job');
  // ...and nothing kept going on its own: one retry, and no second round of
  // cancels against the job that took over.
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(server.deletes).toHaveLength(2);
  expect(server.cancels).toEqual(['job-a', 'job-b']);
});

test('a cancel that is itself refused is named, and the rest still run', async () => {
  // job-a will not stop, so it keeps the capture and the retry is refused —
  // which is exactly when the operator needs to be told WHICH one held on.
  const server = mockServer({ cancelFails: ['job-a'] });
  await openAndAttemptDelete();

  fireEvent.click(await screen.findByTestId('busy-cancel-retry'));

  // The refused one does not stop the other from being cancelled.
  await waitFor(() => expect(server.cancels).toEqual(['job-a', 'job-b']));
  const failures = await screen.findByTestId('busy-cancel-failures');
  expect(failures).toHaveTextContent('job-a');
  expect(failures).toHaveTextContent(/runner is not answering/);
});
