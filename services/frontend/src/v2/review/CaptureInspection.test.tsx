// M4 (qa-ui p12): tab A discards a capture; tab B still has its detail panel
// open. The panel stayed fully interactive, and "Run loss report" / "Run
// integrity report" answered 409 capture_deleted with NOTHING appearing on the
// page — qa-ui diffed the full page text and found no change at all.
//
// Two things had to be true for that silence, and both are covered here: the
// refusal has to be SAID, and the panel has to stop offering controls once it
// learns the capture is gone.

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { CaptureInspection } from './CaptureInspection';
import type { CaptureDetail } from '../../api/types';

const CAP = 'cap-1';

function detail(over: Partial<CaptureDetail> = {}): CaptureDetail {
  return {
    capture_id: CAP,
    run_id: 'run_20260802_100000',
    state: 'completed',
    review_status: 'pending',
    review_revision: 1,
    operator: 'ana',
    task: 'pick_place',
    started_at: '2026-08-02T10:00:00Z',
    ended_at: '2026-08-02T10:01:00Z',
    message_count: 1000,
    bytes: 1_000_000,
    topics: [],
    replica: { instance_id: 'inst', state: 'present_verified' },
    digest_state: 'complete',
    ...over,
  };
}

const CONFIG_OPTIONS = {
  active_robot: 'r',
  robots: [],
  aspects: {
    recording: { active: 'default', options: [] },
    stream: { active: 'default', options: [] },
    validation: { active: 'tmpl', options: [] },
    validators: { active: 'default', options: [] },
  },
};

/** The capture the server returns, and how it answers POST /jobs. */
function mockApi(opts: {
  capture: CaptureDetail;
  /** After a refused job, what a re-read of the capture returns. */
  captureAfterRefusal?: CaptureDetail;
  jobError?: {
    status: number;
    code: string;
    message: string;
    /** The per-code payload the server attaches — capture_busy carries
     *  lease_owner, which is the whole point of its 409. */
    details?: Record<string, unknown>;
  };
}) {
  let current = opts.capture;
  const posted: Record<string, unknown>[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.endsWith('/jobs') && method === 'POST') {
      posted.push(JSON.parse(String(init?.body)));
      if (opts.jobError) {
        if (opts.captureAfterRefusal) current = opts.captureAfterRefusal;
        return Promise.resolve(
          jsonResponse(
            {
              error: {
                code: opts.jobError.code,
                message: opts.jobError.message,
                details: opts.jobError.details,
              },
            },
            opts.jobError.status,
          ),
        );
      }
      return Promise.resolve(jsonResponse({ job_id: 'j1', capture_id: CAP, pipeline: 'x', state: 'queued', progress: 0 }));
    }
    if (url.includes('/config/options')) return Promise.resolve(jsonResponse(CONFIG_OPTIONS));
    if (url.includes(`/captures/${CAP}`)) return Promise.resolve(jsonResponse(current));
    return Promise.resolve(jsonResponse({}));
  });
  return { posted };
}

beforeEach(() => setApiBase('/api/v1'));
afterEach(() => vi.restoreAllMocks());

test('a refused loss report is stated, in the voice of the job that failed', async () => {
  mockApi({
    capture: detail(),
    jobError: {
      status: 409,
      code: 'capture_deleted',
      message: 'cap-1 was discarded',
    },
  });
  renderWithClient(<CaptureInspection captureId={CAP} />);

  fireEvent.click(await screen.findByTestId('review-run-loss'));

  const err = await screen.findByTestId('review-loss-error');
  expect(err).toHaveAttribute('data-error-code', 'capture_deleted');
  expect(err).toHaveTextContent('cap-1 was discarded');
  // The 'job' context, not the review flow's wording about a review that can
  // no longer be changed.
  expect(err.textContent).toMatch(/no files to run a job against/i);
});

test('a refused integrity report is stated too', async () => {
  mockApi({
    capture: detail(),
    jobError: { status: 409, code: 'capture_deleting', message: 'cap-1 is going' },
  });
  renderWithClient(<CaptureInspection captureId={CAP} />);

  fireEvent.click(await screen.findByTestId('review-run-signal'));

  const err = await screen.findByTestId('review-signal-submit-error');
  expect(err).toHaveAttribute('data-error-code', 'capture_deleting');
  expect(err.textContent).toMatch(/no job can be run against it/i);
});

test('a tombstone refusal makes the panel re-read and go terminal', async () => {
  mockApi({
    capture: detail(),
    // The re-read after the 409 finds what tab A did.
    captureAfterRefusal: detail({
      state: 'discarded',
      delete_kind: 'discard',
      delete_reason: 'gripper never closed',
      deleted_at: '2026-08-02T10:05:00Z',
    }),
    jobError: { status: 409, code: 'capture_deleted', message: 'cap-1 was discarded' },
  });
  renderWithClient(<CaptureInspection captureId={CAP} />);

  fireEvent.click(await screen.findByTestId('review-run-loss'));

  const terminal = await screen.findByTestId('review-capture-tombstoned');
  expect(terminal).toHaveAttribute('data-capture-state', 'discarded');
  expect(terminal).toHaveTextContent('This recording was discarded.');
  // The reason survives, because after the bytes go it is the only explanation
  // of why they went.
  expect(terminal).toHaveTextContent('gripper never closed');
  // And the live controls are gone: nothing can be run against it any more.
  await waitFor(() => expect(screen.queryByTestId('review-run-loss')).toBeNull());
  expect(screen.queryByTestId('review-run-signal')).toBeNull();
  expect(screen.queryByTestId('review-run-validation')).toBeNull();
});

test('a capture already tombstoned when the panel opens never offers controls', async () => {
  mockApi({
    capture: detail({
      state: 'deleted',
      delete_kind: 'delete',
      delete_reason: null,
      deleted_at: '2026-08-02T10:05:00Z',
    }),
  });
  renderWithClient(<CaptureInspection captureId={CAP} />);

  const terminal = await screen.findByTestId('review-capture-tombstoned');
  expect(terminal).toHaveTextContent('This recording was deleted.');
  expect(terminal).toHaveTextContent('No reason was recorded.');
  expect(screen.queryByTestId('review-run-loss')).toBeNull();
});

test('a healthy capture still offers its controls and shows no tombstone', async () => {
  mockApi({ capture: detail() });
  renderWithClient(<CaptureInspection captureId={CAP} />);

  expect(await screen.findByTestId('review-run-loss')).toBeInTheDocument();
  expect(screen.queryByTestId('review-capture-tombstoned')).toBeNull();
});

// The operator hit this live: capture_busy on video generation showed the raw
// server envelope — no holder named, no guidance. §7.1 puts lease_owner on both
// the row and the 409 precisely so the UI can say who to wait for.
test('a held lease disables the job controls and names the holder', async () => {
  mockApi({
    capture: detail({
      lease_owner: 'digest-job-7',
      lease_expires_at: new Date(Date.now() + 30_000).toISOString(),
    }),
  });
  renderWithClient(<CaptureInspection captureId={CAP} />);

  const note = await screen.findByTestId('review-capture-busy');
  expect(note).toHaveTextContent('digest-job-7 is working on this capture');
  expect(note.textContent).toMatch(/until \d/);

  // Learned BEFORE the click, on every job control — not from a 409 each time.
  expect(screen.getByTestId('review-run-loss')).toBeDisabled();
  expect(screen.getByTestId('review-run-signal')).toBeDisabled();
  expect(screen.getByTestId('review-run-validation')).toBeDisabled();
  expect(screen.getByTestId('review-run-loss')).toHaveAttribute(
    'title',
    expect.stringContaining('digest-job-7'),
  );
});

test('an expired lease leaves the controls live', async () => {
  // The store compares the expiry when acquiring, so a stale row must not
  // disable a control the server would happily accept.
  mockApi({
    capture: detail({
      lease_owner: 'digest-job-7',
      lease_expires_at: new Date(Date.now() - 1000).toISOString(),
    }),
  });
  renderWithClient(<CaptureInspection captureId={CAP} />);

  expect(await screen.findByTestId('review-run-loss')).toBeEnabled();
  expect(screen.queryByTestId('review-capture-busy')).toBeNull();
});

// The lease can be taken between render and click, so the 409 stays the race
// fallback — and it must speak in the job voice, not the raw envelope.
test('a capture_busy 409 names the holder and says what to wait for', async () => {
  mockApi({
    capture: detail(),
    jobError: {
      status: 409,
      code: 'capture_busy',
      message: 'Another job is working on cap-1; try again in a moment',
      details: { lease_owner: 'digest-job-7', lease_expires_at: '2026-08-03T10:00:30Z' },
    },
  });
  renderWithClient(<CaptureInspection captureId={CAP} />);

  fireEvent.click(await screen.findByTestId('review-run-loss'));

  const err = await screen.findByTestId('review-loss-error');
  expect(err).toHaveAttribute('data-error-code', 'capture_busy');
  expect(err).toHaveTextContent('digest-job-7');
  // The 'job' voice: wait for that one to finish, then run yours — not the
  // delete flow's wording about pulling files from under it.
  expect(err.textContent).toMatch(/Only one job may hold a capture at a time/i);
});

// M4-STALENESS: the panel stayed live-looking for 30s+ after a discard
// elsewhere — enabled buttons, a reassuring QUICK CHECK — until the operator
// pressed something and got a 409. Finding out by being refused is not
// self-correction.
test('an open detail turns terminal on its own, without a click', async () => {
  let discardedYet = false;
  const live = detail();
  const gone = detail({
    state: 'discarded',
    delete_kind: 'discard',
    delete_reason: 'bad take',
    deleted_at: '2026-08-03T10:05:00Z',
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/config/options')) return Promise.resolve(jsonResponse(CONFIG_OPTIONS));
    if (url.includes(`/captures/${CAP}`)) {
      const body = discardedYet ? gone : live;
      discardedYet = true; // the next poll sees what the other tab did
      return Promise.resolve(jsonResponse(body));
    }
    return Promise.resolve(jsonResponse({}));
  });

  renderWithClient(<CaptureInspection captureId={CAP} />);
  expect(await screen.findByTestId('review-run-loss')).toBeInTheDocument();

  // No interaction at all — the panel re-reads itself.
  await waitFor(
    () => expect(screen.getByTestId('review-capture-tombstoned')).toBeInTheDocument(),
    { timeout: 15000 },
  );
  expect(screen.queryByTestId('review-run-loss')).toBeNull();
}, 25000);
