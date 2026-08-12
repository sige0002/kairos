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
import {
  jsonResponse,
  makeTestClient,
  renderWithClient,
} from '../../test/renderWithClient';
import { queryKeys } from '../../api/queryKeys';
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
  /** A submission that never reaches the server at all: fetch rejects rather
   *  than answering. `attempts` bounds it, so a retry can be observed
   *  succeeding after the connection comes back. */
  jobNetworkFailure?: { message?: string; attempts?: number };
  /** What a re-read returns after a submission was lost — the run that got
   *  through anyway and finished, which the panel's own poll then picks up. */
  captureAfterFailure?: CaptureDetail;
}) {
  let current = opts.capture;
  let networkFailuresLeft = opts.jobNetworkFailure
    ? (opts.jobNetworkFailure.attempts ?? Number.POSITIVE_INFINITY)
    : 0;
  const posted: Record<string, unknown>[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.endsWith('/jobs') && method === 'POST') {
      posted.push(JSON.parse(String(init?.body)));
      if (networkFailuresLeft > 0) {
        networkFailuresLeft -= 1;
        if (opts.captureAfterFailure) current = opts.captureAfterFailure;
        // Exactly how a browser reports a request it could not complete: a
        // bare TypeError, no response, no envelope.
        return Promise.reject(
          new TypeError(opts.jobNetworkFailure?.message ?? 'Failed to fetch'),
        );
      }
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

// m9 in Review's detail: the panel led with the raw code —
// "recorder_failed: recorder restarted while the capture was recording" — so
// the reader stepped over an identifier to reach the only part that says what
// happened. Same treatment as the Collect banner: sentence first, code muted
// and last.
test('a failed capture leads with the sentence and trails the code', async () => {
  mockApi({
    capture: detail({
      state: 'failed',
      error: {
        code: 'recorder_failed',
        message: 'recorder restarted while the capture was recording',
      },
    }),
  });
  renderWithClient(<CaptureInspection captureId={CAP} />);

  const note = await screen.findByTestId('review-capture-error');
  expect(note).toHaveAttribute('data-error-code', 'recorder_failed');
  // The code is still on the page — it is what a bug report needs — but the
  // sentence starts the note.
  expect(note.textContent?.startsWith('recorder restarted while the capture')).toBe(true);
  expect(note).toHaveTextContent('(recorder_failed)');
  expect(note.textContent).not.toMatch(/^recorder_failed:/);
});

// ---- the panel colours by MEANING, not by presence -----------------------

test('a take stopped by its own cap is not shown as a failure', async () => {
  // `auto_stopped` is a completed recording that ended exactly where it was
  // configured to. It arrived in the red box because the panel coloured by
  // whether `capture.error` was set at all — so the mechanism is what is
  // fixed here, not this one code: any benign code added later inherits it.
  mockApi({
    capture: detail({
      state: 'completed',
      error: {
        code: 'auto_stopped',
        message: 'auto-stopped: recording ran 600s, reaching MAX_RECORD_SECONDS=600',
      },
    }),
  });
  renderWithClient(<CaptureInspection captureId={CAP} />);

  const note = await screen.findByTestId('review-capture-error');
  // The defect itself, asserted first so the failure names it: a take that
  // did what it was told rendered in the red fault box.
  expect(note.className).not.toMatch(/red/);
  expect(note).toHaveAttribute('data-severity', 'notice');
  // Not a colour-only signal: the classification is also in words, because
  // "why is this box grey" is not a question the colour can answer.
  expect(note).toHaveTextContent('Stopped at the configured limit');
  // The recorder's own sentence still leads the detail, and the code is still
  // there for a bug report — a notice loses the alarm, not the account.
  expect(note.textContent).toContain('reaching MAX_RECORD_SECONDS=600');
  expect(note).toHaveTextContent('(auto_stopped)');
  // And it never calls a completed take a failure.
  expect(note.textContent).not.toMatch(/failed/i);
});

test('a real recorder fault still reads as one', async () => {
  // The other half. Positive control for the panel: if the severity were
  // simply never wired through, the test above could pass on a panel that had
  // stopped being red for everything.
  mockApi({
    capture: detail({
      state: 'failed',
      error: {
        code: 'recorder_failed',
        message: 'recorder restarted while the capture was recording',
      },
    }),
  });
  renderWithClient(<CaptureInspection captureId={CAP} />);

  const note = await screen.findByTestId('review-capture-error');
  expect(note).toHaveAttribute('data-severity', 'fault');
  expect(note.className).toMatch(/red/);
  expect(note.textContent).not.toMatch(/Stopped at the configured limit/);
});

test('an unrecognised code keeps the server sentence and stays red', async () => {
  // The failure mode a severity table invites: a code nobody mapped renders
  // as nothing, or renders as benign. It must do neither.
  mockApi({
    capture: detail({
      state: 'failed',
      error: { code: 'some_future_code', message: 'the disk went away mid-write' },
    }),
  });
  renderWithClient(<CaptureInspection captureId={CAP} />);

  const note = await screen.findByTestId('review-capture-error');
  expect(note).toHaveAttribute('data-severity', 'fault');
  expect(note.className).toMatch(/red/);
  expect(note.textContent).toContain('the disk went away mid-write');
  expect(note).toHaveTextContent('(some_future_code)');
});

test('a notice with no message of its own is not told it failed', async () => {
  // Reachable, not hypothetical: `coerce_error` builds a CaptureError from a
  // STRUCTURED manifest error too, and that branch defaults the message to ""
  // (models.py). A code with no sentence therefore arrives here — and the
  // panel's fallback, written when every note was a fault, would have called
  // a completed take a failure.
  mockApi({
    capture: detail({
      state: 'completed',
      error: { code: 'auto_stopped', message: '' },
    }),
  });
  renderWithClient(<CaptureInspection captureId={CAP} />);

  const note = await screen.findByTestId('review-capture-error');
  expect(note.textContent).not.toMatch(/failed/i);
  // It is not left saying nothing either: the label carries the meaning.
  expect(note).toHaveTextContent('Stopped at the configured limit');
});

test('a FAULT with no message of its own still says something', async () => {
  // The other side of the same fallback, and the reason it was there.
  mockApi({
    capture: detail({ state: 'failed', error: { code: 'recorder_failed', message: '' } }),
  });
  renderWithClient(<CaptureInspection captureId={CAP} />);

  const note = await screen.findByTestId('review-capture-error');
  expect(note).toHaveTextContent('This recording failed.');
});

// ---- #9: a failed attempt beside a stored result -------------------------
//
// Beta case A-05 (2026-08-12, judged FAIL): a validation run whose POST never
// reached the server rendered "Failed to fetch" directly beside an untouched
// PASS badge. Neither carried a time, so there was nothing on the page saying
// which of the two was current — and the only way to try again was to find the
// button that had just failed.

const PASSED = () =>
  detail({
    validation: {
      result: 'pass',
      checked_at: '2026-08-12T11:26:03Z',
      template: { name: 'tmpl', version: 1 },
    },
  });

test('the stored badge is dated with the run’s own completion time', async () => {
  mockApi({ capture: PASSED() });
  renderWithClient(<CaptureInspection captureId={CAP} />);

  const checked = await screen.findByTestId('review-validation-checked');
  // The report's `checked_at`, rendered — not this client's clock, and not a
  // stand-in for a time the report did not carry.
  expect(checked).toHaveTextContent(
    `checked ${new Date('2026-08-12T11:26:03Z').toLocaleString('en-GB', { hour12: false })}`,
  );
});

test('a report with no time of its own is labelled, not given one', async () => {
  // A pipeline from before `checked_at` existed. Inventing a time here would
  // be the worst of both: a badge that looks current because the UI dated it.
  mockApi({ capture: detail({ validation: { result: 'pass' } }) });
  renderWithClient(<CaptureInspection captureId={CAP} />);

  const checked = await screen.findByTestId('review-validation-checked');
  expect(checked).toHaveTextContent('last completed check');
  expect(checked.textContent).not.toMatch(/\d{4}/);
});

test('a check that never reaches the server is separated from the stored PASS', async () => {
  mockApi({ capture: PASSED(), jobNetworkFailure: {} });
  renderWithClient(<CaptureInspection captureId={CAP} />);

  fireEvent.click(await screen.findByTestId('review-run-validation'));

  const err = await screen.findByTestId('review-validation-error');
  // The defect, asserted first so a regression names it: the browser's own
  // string was what the operator read.
  expect(err.textContent).not.toMatch(/failed to fetch/i);
  expect(err).toHaveAttribute('data-error-code', 'network_unreachable');
  expect(err.textContent).toMatch(/could not reach the server/i);
  // Plain-language guidance, and no overclaiming: a lost connection does not
  // establish that the run never started.
  expect(err.textContent).toMatch(/orchestrator is running/i);
  expect(err.textContent).toMatch(/not known/i);

  // And the badge is no longer left to be read as this attempt's answer.
  const stale = screen.getByTestId('review-validation-error-stale');
  expect(stale.textContent).toMatch(/PASS badge above is the last completed check/i);
  expect(stale.textContent).toMatch(/not this attempt/i);
  // The stored verdict itself is untouched — the failure annotates it, it does
  // not erase a real result the server still holds.
  expect(screen.getByTestId('review-validation-checked')).toHaveTextContent('checked');
});

test('the failed attempt carries its own way to try again', async () => {
  const { posted } = mockApi({ capture: PASSED(), jobNetworkFailure: { attempts: 1 } });
  renderWithClient(<CaptureInspection captureId={CAP} />);

  fireEvent.click(await screen.findByTestId('review-run-validation'));
  const retry = await screen.findByTestId('review-validation-error-retry');
  expect(retry).toBeEnabled();

  fireEvent.click(retry);

  // The same work, resubmitted from the note — same pipeline, same capture,
  // same template as the run that failed.
  await waitFor(() => expect(posted).toHaveLength(2));
  expect(posted[1]).toEqual(posted[0]);
  expect(posted[1]).toMatchObject({
    pipeline: 'fast_validation',
    capture_id: CAP,
    params: { template: 'tmpl' },
  });
  // The second attempt was accepted, so the note goes.
  await waitFor(() => expect(screen.queryByTestId('review-validation-error')).toBeNull());
});

test('a capture with no stored result claims none', async () => {
  // The other direction of the same honesty: with nothing on file, the note
  // must not tell the operator it is showing a last completed check.
  mockApi({ capture: detail(), jobNetworkFailure: {} });
  renderWithClient(<CaptureInspection captureId={CAP} />);

  fireEvent.click(await screen.findByTestId('review-run-validation'));

  await screen.findByTestId('review-validation-error');
  expect(screen.queryByTestId('review-validation-error-stale')).toBeNull();
  expect(screen.queryByTestId('review-validation-checked')).toBeNull();
});

test('a stale loss table is separated from a failed loss attempt too', async () => {
  // The same shape, one section up: the error note sits above a table the
  // server stored earlier.
  mockApi({
    capture: detail({
      loss: { topics: [{ name: '/head_camera/image_raw', count: 900, hz: 30 }] },
    }),
    jobNetworkFailure: {},
  });
  renderWithClient(<CaptureInspection captureId={CAP} />);

  fireEvent.click(await screen.findByTestId('review-run-loss'));

  const stale = await screen.findByTestId('review-loss-error-stale');
  expect(stale.textContent).toMatch(/last completed loss report, not this attempt/i);
  expect(screen.getByTestId('review-loss-error-retry')).toBeEnabled();
});

// F1: the note points AT the stored result, the mutation error is frozen where
// it happened, and the panel re-reads itself every CAPTURE_DETAIL_POLL_MS. So
// the run whose ANSWER was lost while the run itself completed — the exact case
// the guidance hedges about — used to refresh the badge underneath a note still
// calling it the last completed check, denying the very result it pointed at.
test('a check that lands after the attempt fails is not denied by the note', async () => {
  const client = makeTestClient();
  mockApi({
    capture: PASSED(),
    jobNetworkFailure: {},
    // The submission reached the server after all; only its answer was lost.
    captureAfterFailure: detail({
      validation: {
        result: 'fail',
        checked_at: '2026-08-12T11:41:00Z',
        template: { name: 'tmpl', version: 1 },
      },
    }),
  });
  renderWithClient(<CaptureInspection captureId={CAP} />, { client });

  fireEvent.click(await screen.findByTestId('review-run-validation'));
  await screen.findByTestId('review-validation-error');

  // Stand in for the 10 s detail poll: the panel re-reads the capture and finds
  // the verdict of the run that got through.
  void client.invalidateQueries({ queryKey: queryKeys.capture(CAP) });
  await waitFor(() =>
    expect(screen.getByTestId('review-validation-checked')).toHaveTextContent(
      new Date('2026-08-12T11:41:00Z').toLocaleString('en-GB', { hour12: false }),
    ),
  );

  // The defect: the note went on calling a result that landed AFTER this
  // attempt "the last completed check ... not this attempt".
  const stale = screen.getByTestId('review-validation-error-stale');
  expect(stale.textContent).not.toMatch(/not this attempt/i);
  expect(stale.textContent).toMatch(/completed after this attempt failed/i);
  // And it does not swing to the opposite overclaim either — another terminal
  // could have run that check, so the attribution stays hedged.
  expect(stale.textContent).toMatch(/possibly/i);
});

test('a result that has not moved is still named as the last completed check', async () => {
  // The control for the test above: without this, dropping the claim entirely
  // would pass just as well, and the note would stop saying the one thing it
  // exists to say.
  const client = makeTestClient();
  mockApi({ capture: PASSED(), jobNetworkFailure: {} });
  renderWithClient(<CaptureInspection captureId={CAP} />, { client });

  fireEvent.click(await screen.findByTestId('review-run-validation'));
  await screen.findByTestId('review-validation-error');

  void client.invalidateQueries({ queryKey: queryKeys.capture(CAP) });
  await waitFor(() => expect(screen.getByTestId('review-validation-error-stale')).toBeInTheDocument());
  expect(screen.getByTestId('review-validation-error-stale').textContent).toMatch(
    /PASS badge above is the last completed check.*not this attempt/i,
  );
});

// F6: `formatWhen` echoes anything it cannot parse, so a malformed sidecar
// rendered "checked 2026-13-45T99:99:99Z" — which still reads as a date.
test('an unparseable checked_at is dropped, not echoed', async () => {
  mockApi({
    capture: detail({ validation: { result: 'pass', checked_at: '2026-13-45T99:99:99Z' } }),
  });
  renderWithClient(<CaptureInspection captureId={CAP} />);

  const checked = await screen.findByTestId('review-validation-checked');
  expect(checked).toHaveTextContent('last completed check');
  expect(checked.textContent).not.toMatch(/2026-13-45/);
});

// F3: the loss table is called "the last completed loss report" by a failed
// attempt, so it has to be datable too — loss_report stamps `checked_at` just
// as fast_validation does.
test('the stored loss table is dated like the validation badge', async () => {
  mockApi({
    capture: detail({
      loss: {
        topics: [{ name: '/head_camera/image_raw', count: 900, hz: 30 }],
        checked_at: '2026-08-12T09:15:00Z',
      },
    }),
  });
  renderWithClient(<CaptureInspection captureId={CAP} />);

  const checked = await screen.findByTestId('review-loss-checked');
  expect(checked).toHaveTextContent(
    `checked ${new Date('2026-08-12T09:15:00Z').toLocaleString('en-GB', { hour12: false })}`,
  );
});

// ---- F2: one note, for the latest attempt --------------------------------
//
// The integrity section has two error channels that do not clear each other:
// `jobError` (a job that ran and failed) is reset only when a LATER submission
// succeeds. So a pipeline failure followed by a re-run into a dead network left
// both set, and the section rendered two identical role="alert" boxes with two
// identical Retry buttons, describing different attempts.

/** POST /jobs answers `jobPosts` in order — 'ok' accepts, 'network' rejects —
 *  and the accepted job then runs and fails inside the pipeline. */
function mockSignalApi(jobPosts: ('ok' | 'network')[]) {
  let call = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.endsWith('/jobs') && method === 'POST') {
      const answer = jobPosts[call++] ?? 'ok';
      if (answer === 'network') return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.resolve(
        jsonResponse({ job_id: 'j1', capture_id: CAP, pipeline: 'signal_report', state: 'queued' }),
      );
    }
    if (url.includes('/jobs/j1/status'))
      return Promise.resolve(
        jsonResponse({ job_id: 'j1', capture_id: CAP, pipeline: 'signal_report', state: 'failed' }),
      );
    if (url.includes('/jobs/j1/result'))
      return Promise.resolve(
        jsonResponse({
          summary: { error: { code: 'pipeline_unavailable', message: 'bagflow is not bundled' } },
        }),
      );
    if (url.includes('/config/options')) return Promise.resolve(jsonResponse(CONFIG_OPTIONS));
    if (url.includes(`/captures/${CAP}`)) return Promise.resolve(jsonResponse(detail()));
    return Promise.resolve(jsonResponse({}));
  });
}

test('a job that ran and failed is stated, and offers its own retry', async () => {
  // No coverage existed for this channel at all — it was a bare <p> with the
  // raw sentence and no way forward but the button that had just failed.
  mockSignalApi(['ok']);
  renderWithClient(<CaptureInspection captureId={CAP} />);

  fireEvent.click(await screen.findByTestId('review-run-signal'));

  const err = await screen.findByTestId('review-signal-error');
  expect(err).toHaveTextContent('bagflow is not bundled');
  expect(screen.getByTestId('review-signal-error-retry')).toBeEnabled();
});

test('a lost re-run replaces the previous failure instead of stacking on it', async () => {
  mockSignalApi(['ok', 'network']);
  renderWithClient(<CaptureInspection captureId={CAP} />);

  fireEvent.click(await screen.findByTestId('review-run-signal'));
  await screen.findByTestId('review-signal-error');

  // Re-run from the note itself — the second submission never lands.
  fireEvent.click(screen.getByTestId('review-signal-error-retry'));

  const submit = await screen.findByTestId('review-signal-submit-error');
  expect(submit).toHaveAttribute('data-error-code', 'network_unreachable');
  // The defect: two alerts, two Retry buttons, two different attempts.
  await waitFor(() => expect(screen.queryByTestId('review-signal-error')).toBeNull());
  expect(screen.getAllByTestId(/^review-signal-.*-retry$/)).toHaveLength(1);
});

// N3: the moved-on branch names "the badge above", but the badge is gated on a
// `result` the note never checked. A report can move to something this panel
// renders nothing for — vanish in a store rebuild, or land without a verdict —
// and then the sentence points at empty space.
test('the moved-on note is not shown when there is no badge to point at', async () => {
  const client = makeTestClient();
  mockApi({
    capture: PASSED(),
    jobNetworkFailure: {},
    // The report moved, but to something with no verdict in it.
    captureAfterFailure: detail({ validation: { checked_at: '2026-08-12T11:41:00Z' } }),
  });
  renderWithClient(<CaptureInspection captureId={CAP} />, { client });

  fireEvent.click(await screen.findByTestId('review-run-validation'));
  await screen.findByTestId('review-validation-error');

  void client.invalidateQueries({ queryKey: queryKeys.capture(CAP) });
  await waitFor(() => expect(screen.queryByTestId('review-validation-checked')).toBeNull());

  // The failure is still stated — only the claim about a badge is dropped.
  expect(screen.getByTestId('review-validation-error')).toBeInTheDocument();
  expect(screen.queryByTestId('review-validation-error-stale')).toBeNull();
});
