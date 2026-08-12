// Readings of the capture-store error codes — the part of an error the backend
// cannot write for itself: what the operator should DO next.
//
// These are unit tests because a reading is a pure function of the envelope,
// and the envelopes are contracts the orchestrator's routers already fix. Where
// a reading is rendered is tested at the screen that renders it.

import { expect, test } from 'vitest';
import { ApiError } from '../../api/client';
import {
  captureErrorText,
  isDestructiveFailure,
  needsReload,
  readCaptureCode,
  readCaptureError,
} from './errors';

function apiError(
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): ApiError {
  return new ApiError(status, { error: { code, message, details } }, 'fallback');
}

// The real 409 from dataset_archive.py: another dataset already holds this
// archive folder. `held_by` is the holding dataset's dataset_id.
const CLAIMED = () =>
  apiError(
    409,
    'destination_claimed',
    '/mnt/archive/op_a/pick_place/kitchen picks belongs to dataset shelf ' +
      'picks, which is archiving there. Two datasets in one folder would ' +
      'interleave their numbers under a single manifest; choose another path.',
    {
      dataset_id: 'ds-kitchen',
      destination: '/mnt/archive/op_a/pick_place/kitchen picks',
      held_by: 'ds-shelf',
    },
  );

test('a claimed archive destination carries the holder identity for the UI to resolve', () => {
  const reading = readCaptureError(CLAIMED());
  expect(reading.code).toBe('destination_claimed');
  // The server's sentence is kept intact — it is the first line shown.
  expect(reading.message).toContain('choose another path');
  // `held_by` is the addressable identity, and the reading passes it through.
  // The guidance deliberately does NOT print it: the envelope has the id and
  // the message has the NAME, and showing the two unlabelled and adjacent
  // ("shelf picks" in the alert, "ds-shelf" underneath) is worse than either
  // alone. The dialog joins them against the catalog it already holds.
  expect(reading.details.held_by).toBe('ds-shelf');
  expect(reading.guidance).not.toContain('ds-shelf');
  // So the guidance has to stand on its own wherever it is shown.
  expect(reading.guidance).toMatch(/another dataset/i);
});

// The same code answers the per-capture archive (captures.py) AND the whole
// dataset archive (dataset_archive.py), so its guidance may not name one of
// them: on the dataset dialog, what a full folder would mix is datasets.
test('the full-destination reading is worded for both archive surfaces', () => {
  const reading = readCaptureError(
    apiError(
      409,
      'destination_not_empty',
      '/mnt/archive/x already contains files — refusing to archive into it. ' +
        'Choose another path, or clear it if it is the debris of an abandoned run.',
      { destination: '/mnt/archive/x' },
    ),
  );
  expect(reading.guidance).not.toMatch(/captures/i);
  // And it must not quietly withdraw the option the server just offered:
  // unlike a CLAIMED destination, clearing debris here genuinely frees the
  // path, and that contrast is the whole difference between the two codes.
  expect(reading.guidance).toMatch(/clear/i);
  expect(readCaptureError(CLAIMED()).guidance).not.toMatch(/\bclear\b/i);
});

// The two things an operator naturally tries — empty the folder, or wait for
// the other run to finish — are both useless here, and nothing else on screen
// says so. store.py's begin_dataset_archive holds the claim against the
// dataset ROW: an archived dataset keeps its folder permanently, and a halted
// run keeps its own even after the debris is cleared, because Resume returns.
test('the claimed-destination reading says the claim is not released by waiting or emptying', () => {
  const { guidance } = readCaptureError(CLAIMED());
  expect(guidance).toMatch(/empt/i);
  expect(guidance).toMatch(/finish/i);
  // And it says what DOES work.
  expect(guidance).toMatch(/another|different/i);
});

// Nothing was copied and nothing was lost — this is a refusal to start, so it
// must not be styled as a destructive failure, and there is nothing to re-apply
// after a refetch.
test('a claimed destination is a warning, not a destructive failure, and needs no reload', () => {
  const reading = readCaptureError(CLAIMED());
  expect(reading.severity).toBe('warning');
  expect(reading.reload).toBe(false);
});

// Defensive: an envelope with no held_by must still read as a whole sentence
// and still give the same next step — the identity is the dialog's to add.
test('a claimed destination with no held_by still gives the next step', () => {
  const reading = readCaptureError(
    apiError(409, 'destination_claimed', 'That folder is taken.', {}),
  );
  expect(reading.guidance).not.toMatch(/undefined|null/);
  expect(reading.guidance).toMatch(/another|different/i);
});

// The toast form is message + guidance, in that order.
test('the one-line form leads with the server sentence', () => {
  const text = captureErrorText(CLAIMED());
  expect(text.indexOf('choose another path')).toBeLessThan(
    text.indexOf('belongs to another dataset'),
  );
});

// The lifecycle ledger has a line that does not parse — hand-edited, or a
// damaged write. 503, and deliberately the sibling of `ledger_unwritable`.
// The distinction that has to survive into the wording: the operation was not
// answered, rather than attempted and failed, and no amount of retrying makes
// a corrupt file parse.
const LEDGER_UNREADABLE = () =>
  apiError(
    503,
    'ledger_unreadable',
    'The lifecycle ledger (/data/lifecycle.jsonl) could not be read: invalid ' +
      'JSON on line 812. The number a returning recording takes back is ' +
      'recorded only there, so adding a member now could issue a number that ' +
      'already belongs to another take. Repair or restore the file, then try again.',
    { dataset_id: 'ds-kitchen', capture_id: 'cap-a' },
  );

test('an unreadable ledger says the file must be repaired, never that it will pass', () => {
  const reading = readCaptureError(LEDGER_UNREADABLE());
  expect(reading.code).toBe('ledger_unreadable');
  expect(reading.guidance).toMatch(/repair|restore/i);
  // The one thing this guidance must never say. A 503 usually means "try again
  // shortly"; this one will read exactly the same on every retry, and telling
  // an operator to wait it out is the `destination_claimed` failure again —
  // advice that cannot work.
  expect(reading.guidance).not.toMatch(/try again|in a moment|shortly|later|wait/i);
  // Nothing to refetch: the file is what is wrong, not this client's copy.
  expect(reading.reload).toBe(false);
});

test('an unreadable ledger is destructive-severity, like its unwritable sibling', () => {
  // Not because data was lost — nothing was — but because it must not pass as a
  // note that fades. It blocks membership numbering and halts an archive run
  // until a human repairs a file, and §12 reserves this severity for exactly
  // the failures an operator has to acknowledge.
  expect(readCaptureError(LEDGER_UNREADABLE()).severity).toBe('destructive');
  expect(isDestructiveFailure(LEDGER_UNREADABLE())).toBe(true);
  // Same standing as the sibling it was modelled on.
  expect(readCaptureError(apiError(503, 'ledger_unwritable', 'x')).severity).toBe(
    'destructive',
  );
});

// The graceful-degradation contract the table relies on: an unmapped code still
// shows the server's sentence, with no invented advice.
test('an unmapped code degrades to the server sentence with no guidance', () => {
  const reading = readCaptureError(apiError(409, 'some_new_code', 'Something specific.'));
  expect(reading.message).toBe('Something specific.');
  expect(reading.guidance).toBe('');
  expect(captureErrorText(apiError(409, 'some_new_code', 'Something specific.'))).toBe(
    'Something specific.',
  );
});

// ---- readings reached by CODE (no envelope to throw) ----------------------
//
// The dataset archive runner reports a halt as a plain `{code, message}` inside
// its progress payload — there is no ApiError to hand `readCaptureError`. The
// dialog showing that halt therefore had the code and the sentence but no way
// to reach the guidance, which is how the operator ends up stopped in front of
// a halted run with no next step.

test('a reading can be reached by code alone, with the same guidance', () => {
  const byCode = readCaptureCode('ledger_unreadable', 'The ledger could not be read: line 812.');
  const byEnvelope = readCaptureError(LEDGER_UNREADABLE());
  expect(byCode.guidance).toBe(byEnvelope.guidance);
  expect(byCode.severity).toBe(byEnvelope.severity);
  expect(byCode.message).toBe('The ledger could not be read: line 812.');
});

test('a code the catalog does not know keeps the server sentence and invents nothing', () => {
  const reading = readCaptureCode('some_runner_code', 'The run stopped for a reason of its own.');
  expect(reading.message).toBe('The run stopped for a reason of its own.');
  expect(reading.guidance).toBe('');
});

// The runner's payload types `code` and `message` as OPTIONAL, so both can be
// absent — a halt with no code must not render "undefined" at an operator.
test('a halt with no code and no message degrades to empty, not to "undefined"', () => {
  const reading = readCaptureCode(undefined, undefined);
  expect(reading.message).toBe('');
  expect(reading.guidance).toBe('');
  expect(reading.code).toBe('');
});

// ---- failures with no envelope at all ------------------------------------
//
// #9, beta case A-05: a validation run whose POST never reached the server put
// the browser's own "Failed to fetch" in the Review panel, beside an untouched
// PASS badge. The string names no subject and no next step, and read against
// the badge it did not even make clear that what failed was the attempt.

test('a fetch that never reached the server reads as a reachability problem', () => {
  const reading = readCaptureError(new TypeError('Failed to fetch'), 'job');
  expect(reading.code).toBe('network_unreachable');
  // The defect itself: the browser's sentence is no longer what the operator
  // is shown.
  expect(reading.message).not.toMatch(/failed to fetch/i);
  expect(reading.message).toMatch(/could not reach the server/i);
  expect(reading.guidance).toMatch(/orchestrator is running/i);
  // And it does not overclaim: a dead connection says nothing about whether
  // the request arrived, so the guidance names how to find out instead of
  // promising that nothing happened.
  expect(reading.guidance).toMatch(/not known/i);
  // Kept for a bug report, but off the screen — being shown it is the defect.
  expect(reading.details.transport_message).toBe('Failed to fetch');
});

test('the reachability reading speaks in the voice of the action that failed', () => {
  const job = readCaptureError(new TypeError('Failed to fetch'), 'job');
  const review = readCaptureError(new TypeError('Failed to fetch'), 'review');
  expect(job.guidance).toMatch(/if a retry comes back busy/i);
  expect(review.guidance).toMatch(/reload the recording/i);
  expect(job.guidance).not.toBe(review.guidance);
});

test('the same failure is recognised across browsers, not just Chromium', () => {
  // The beta ran on Chromium; Firefox and Safari word it differently, and the
  // test runner's fetch (undici) differently again. A mapping that only knew
  // one of them would quietly regress to the raw string for everyone else.
  for (const message of [
    'NetworkError when attempting to fetch resource.',
    'Load failed',
    'fetch failed',
  ]) {
    expect(readCaptureError(new TypeError(message)).code).toBe('network_unreachable');
  }
});

test('the client deadline reads as its own thing, not as a dead network', () => {
  // api/client.ts arms AbortSignal.timeout on every request, so this is what a
  // server that accepted the work and then went quiet looks like — and the
  // advice is the opposite of a retry.
  const reading = readCaptureError(new DOMException('signal timed out', 'TimeoutError'), 'job');
  expect(reading.code).toBe('network_timeout');
  expect(reading.message).toMatch(/did not answer in time/i);
  expect(reading.guidance).toMatch(/may still be going/i);
});

test('a TypeError that is not a fetch failure is not diagnosed as one', () => {
  // The honesty half. A bug in our own call arrives as a TypeError too, and
  // reading it as a network fault would send the operator to check a cable
  // that was never the problem — so it degrades exactly as before.
  const reading = readCaptureError(
    new TypeError("Cannot read properties of undefined (reading 'topics')"),
  );
  expect(reading.code).toBe('unknown');
  expect(reading.guidance).toBe('');
  expect(reading.message).toMatch(/Cannot read properties/);
});

test('a transport failure destroys nothing and triggers no blind refetch', () => {
  // Two switches other screens read off this reading: `isDestructiveFailure`
  // forces a dismissed banner, `needsReload` fires an automatic refetch. A
  // screen that cannot reach the server has nothing to refetch WITH, and
  // nothing was lost, so both stay off.
  const error = new TypeError('Failed to fetch');
  expect(isDestructiveFailure(error)).toBe(false);
  expect(needsReload(error)).toBe(false);
});

test('the one-line toast form carries the reading, not the browser string', () => {
  const text = captureErrorText(new TypeError('Failed to fetch'), 'job');
  expect(text).not.toMatch(/failed to fetch/i);
  expect(text).toMatch(/could not reach the server/i);
  expect(text).toMatch(/orchestrator/i);
});
