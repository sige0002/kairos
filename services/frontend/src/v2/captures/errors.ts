// Operator-facing readings of the capture-store error codes.
//
// The backend already writes good messages; what it cannot know is what the
// operator should DO next, which differs sharply between codes that all arrive
// as "409". This module turns a code into that instruction, and marks which
// ones are severe enough that the UI must not let them pass as a quiet
// inline note (§12: a failed review save is stated explicitly, never silently).
//
// Several codes are shared by more than one action: `capture_busy`,
// `capture_deleting` and `capture_deleted` answer a review save, a removal AND
// a job submission. The right next step is not the same for all three — being
// told to wait before deleting is no help to someone who was trying to run a
// job — so the reading takes the CONTEXT of the action that failed. Callers
// that do not pass one get the neutral wording, never another action's.
//
// Failures that never reached an answer at all are read here too: they have no
// envelope, but the operator still has to be told something better than the
// browser's own sentence (see "no envelope to read" below).

import { ApiError } from '../../api/client';

export type ErrorSeverity = 'warning' | 'destructive';

/** Which action the operator was performing when the call failed. */
export type ErrorContext = 'review' | 'delete' | 'job';

export interface CaptureErrorReading {
  code: string;
  /** The backend's own message — always the first line shown. */
  message: string;
  /** What to do about it, in the operator's terms. */
  guidance: string;
  severity: ErrorSeverity;
  /** True when the client should refetch and let the operator re-apply. */
  reload: boolean;
  details: Record<string, unknown>;
}

/** One job holding the §7.1 lease on a capture, as a `capture_busy` reports it. */
export interface LeaseHolder {
  /** The raw owner string, e.g. `job:019f…`. */
  owner: string;
  /** The job id, with the `job:` prefix stripped — what `POST /jobs/{id}/cancel`
   *  takes. Null when the owner is NOT a job (a transfer, the digest queue):
   *  those hold the capture for reasons this screen cannot cancel, and offering
   *  to would be offering something that does not exist. */
  jobId: string | null;
  /** When this holder's lease lapses on its own. Null when unstated. */
  expiresAt: string | null;
}

const JOB_OWNER_PREFIX = 'job:';

/**
 * Every holder named by a `capture_busy` refusal, soonest to expire last as the
 * server orders them.
 *
 * Reads the `holders` array when the server sends one and falls back to the
 * single `lease_owner` / `lease_expires_at` pair otherwise — a backend from
 * before the list still refuses the same way, and one named holder is better
 * than pretending there are none.
 */
export function readLeaseHolders(details: Record<string, unknown>): LeaseHolder[] {
  const raw = details.holders;
  const toHolder = (owner: string, expiresAt: string | null): LeaseHolder => ({
    owner,
    jobId: owner.startsWith(JOB_OWNER_PREFIX)
      ? owner.slice(JOB_OWNER_PREFIX.length) || null
      : null,
    expiresAt,
  });
  if (Array.isArray(raw)) {
    const holders: LeaseHolder[] = [];
    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null) continue;
      const row = entry as Record<string, unknown>;
      const owner = detailString(row, 'owner');
      if (!owner) continue;
      holders.push(toHolder(owner, detailString(row, 'expires_at')));
    }
    if (holders.length > 0) return holders;
  }
  const owner = detailString(details, 'lease_owner');
  return owner ? [toHolder(owner, detailString(details, 'lease_expires_at'))] : [];
}

function detailString(details: Record<string, unknown>, key: string): string | null {
  const value = details[key];
  return typeof value === 'string' && value ? value : null;
}

/** Per-context wording for the codes more than one action can raise. The
 *  `default` arm is what a caller that named no context sees. */
const CONTEXTUAL: Record<
  string,
  { severity: ErrorSeverity; reload?: boolean; byContext: Partial<Record<ErrorContext, string>> & { default: string } }
> = {
  capture_deleting: {
    severity: 'warning',
    reload: true,
    byContext: {
      review:
        'This capture is being deleted, so its review can no longer be ' +
        'changed. The delete wins; nothing you typed was saved.',
      delete: 'This capture is already on its way out — the removal is running.',
      job:
        'This capture is being deleted, so no job can be run against it. Its ' +
        'files are about to go.',
      default: 'This capture is being deleted, so it can no longer be changed.',
    },
  },
  capture_deleted: {
    severity: 'warning',
    reload: true,
    byContext: {
      review:
        'This capture has already been deleted, so its review can no longer ' +
        'be changed.',
      delete: 'This capture has already been removed — there is nothing left to delete.',
      job: 'This capture has already been deleted, so there are no files to run a job against.',
      default: 'This capture has already been deleted.',
    },
  },
};

const GUIDANCE: Record<string, { guidance: string; severity: ErrorSeverity; reload?: boolean }> = {
  review_conflict: {
    guidance:
      'Someone else saved a review for this capture first. Reload it and apply ' +
      'your change again — the two edits are not merged.',
    severity: 'warning',
    reload: true,
  },
  review_sidecar_write_failed: {
    guidance:
      'NOTHING was saved — record.json could not be written. Free up disk ' +
      'space or fix the permissions, then save again.',
    severity: 'destructive',
  },
  capture_not_present: {
    guidance:
      'There is no local copy of this capture and none is on the way, so its ' +
      'review cannot be written.',
    severity: 'warning',
    reload: true,
  },
  capture_recording: {
    guidance: 'Stop the recording before deleting it.',
    severity: 'warning',
  },
  capture_in_dataset: {
    guidance:
      'This capture belongs to a dataset. Remove it from the dataset first — ' +
      'removing it underneath would leave the dataset citing something gone. ' +
      'The same applies to archiving, which also takes the bytes away.',
    severity: 'warning',
  },
  dataset_member_exists: {
    guidance: 'This capture is already a member of that dataset.',
    severity: 'warning',
  },
  dataset_member_not_found: {
    guidance:
      'That membership no longer exists — someone else may have removed it. ' +
      'Reload the dataset.',
    severity: 'warning',
    reload: true,
  },
  dataset_not_found: {
    guidance: 'That dataset no longer exists. Reload the list.',
    severity: 'warning',
    reload: true,
  },
  capture_not_found: {
    guidance: 'That capture is not in the catalog. Reload and try again.',
    severity: 'warning',
    reload: true,
  },
  reserved_name: {
    guidance:
      'That name collides with a directory the store reserves for itself ' +
      '(objects, views, report, catalog and friends). Choose another.',
    severity: 'warning',
  },
  // The part the server does not say: the claim is PERMANENT.
  // `begin_dataset_archive` (store.py) holds a destination against the dataset
  // ROW, not the files in it — an archived dataset keeps its folder for good, a
  // halted run keeps its own even after an operator clears the debris, a run
  // that finishes only turns `archiving` into `archived` (still in the scan),
  // and the ledger has no release event at all, so the hold survives a rebuild.
  // Emptying the folder and waiting the other run out are the two things an
  // operator tries first; neither frees the path and the first destroys data.
  //
  // WHICH dataset holds it is deliberately not printed here. The envelope
  // carries `held_by` (an id) while the server's message carries the NAME, and
  // rendering the two unlabelled and adjacent reads as two different datasets.
  // The archive dialogs join them against the catalog they already hold
  // (datasets/ArchiveError.tsx), which is the only place the name is known.
  destination_claimed: {
    guidance:
      'The folder belongs to another dataset for good: the claim is on the ' +
      'dataset, not on the files in it, so emptying the folder does not ' +
      'release it and neither does that dataset finishing its run. Archive to ' +
      'a different path — one no dataset has used.',
    severity: 'warning',
  },
  // Raised by BOTH archive routes — captures.py for one recording,
  // dataset_archive.py for a whole dataset — so the wording names neither: on
  // the dataset dialog what a full folder would mix is datasets. And it keeps
  // the second way out the server itself offers, because withdrawing an option
  // the operator was just given reads as the two lines disagreeing. Clearing
  // really does free a FULL destination, which is exactly what separates this
  // from `destination_claimed`, where it frees nothing and destroys data.
  destination_not_empty: {
    guidance:
      'Two archives in one folder could not be told apart afterwards. Pick an ' +
      'empty path — or, as the message says, clear this one first if what is ' +
      'in it is only the debris of a run that never finished.',
    severity: 'warning',
  },
  reason_required: {
    guidance:
      'A discard is irreversible and the ledger line is the only surviving ' +
      'explanation of why the data is gone. Give a reason.',
    severity: 'warning',
  },
  delete_unavailable: {
    guidance:
      'Deleting is switched off on this deployment because objects/, .trash/ ' +
      'and .incoming/ are not on one filesystem — the move to trash would not ' +
      'be atomic. Fix the mounts and restart the orchestrator.',
    severity: 'warning',
  },
  ledger_unwritable: {
    guidance:
      'The lifecycle ledger could not be written, so nothing was deleted. The ' +
      'ledger is written first on purpose: without its line there would be no ' +
      'record that the data ever existed.',
    severity: 'destructive',
  },
  // The sibling of the above, and the mirror image: there the ledger could not
  // be WRITTEN, here a line in it cannot be READ. Both are 503, and neither is
  // the transient 503 that word usually promises — this one reads identically
  // on every retry, because a corrupt line does not become valid by waiting.
  // So the guidance names the repair instead of a delay: telling an operator to
  // try again shortly would be advice that cannot work.
  //
  // Destructive severity for what it BLOCKS, not for anything lost (nothing
  // is): the number a returning recording takes back lives only in the ledger,
  // so membership cannot be numbered, and an archive run halts where it stood.
  // Both need a human and a file — not a note that fades.
  ledger_unreadable: {
    guidance:
      'The ledger has a line that does not parse — hand-edited, or a damaged ' +
      'write — so this could not be answered from the store’s own history ' +
      'rather than having failed. Repair or restore lifecycle.jsonl; until it ' +
      'reads, a number cannot be issued and a halted archive run stays where ' +
      'it stopped.',
    severity: 'destructive',
  },
  volume_unidentified: {
    guidance:
      'The data volume has no readable marker, so it cannot be confirmed as ' +
      'the one the catalog describes. Check that the storage is mounted, then ' +
      'repair again.',
    severity: 'warning',
  },
  capture_not_finished: {
    guidance: 'The recording is still being written — wait for it to stop.',
    severity: 'warning',
  },
  archive_copy_failed: {
    guidance:
      'The copy to the archive destination failed, so the original was NOT ' +
      'removed. Nothing has been lost.',
    severity: 'destructive',
  },
};

// ---- failures with no envelope to read ------------------------------------
//
// `api/client.ts` does not wrap fetch, so a request that never got an answer
// arrives as the browser's own object rather than as an ApiError: a `TypeError`
// when the connection could not be made or died mid-flight, and a
// `TimeoutError` when the client's own deadline (DEFAULT_TIMEOUT_MS) fired.
// Both used to fall straight through to the unknown degradation below and
// render as the raw browser string. "Failed to fetch" names no subject, offers
// no next step, and — beside a stored PASS badge — does not even say that what
// failed was the attempt rather than the recording.
//
// What these readings must NOT do is claim more than is known. A connection
// that fails says nothing about whether the request arrived: the work may have
// started and only its answer been lost. So the guidance names the way to find
// out instead of asserting that nothing happened.

interface TransportReading {
  code: string;
  message: string;
  /** Per-action guidance; `default` is what a caller with no context sees. */
  byContext: Partial<Record<ErrorContext, string>> & { default: string };
}

const NETWORK_UNREACHABLE: TransportReading = {
  code: 'network_unreachable',
  message: 'Could not reach the server — the request got no answer.',
  byContext: {
    job:
      'Check that the orchestrator is running and reachable, then try again. ' +
      'Whether the run started is not known from here: if a retry comes back ' +
      'busy, one did.',
    review:
      'Check that the orchestrator is running and reachable, then save again. ' +
      'Nothing here confirms the save either way — reload the recording to see ' +
      'what the server actually holds.',
    delete:
      'Check that the orchestrator is running and reachable, then try again. ' +
      'Whether the removal started is not known from here — reload the list ' +
      'before assuming it did not.',
    default:
      'Check that the orchestrator is running and reachable, then try again. ' +
      'Whether the request arrived is not known from here — reload before ' +
      'assuming nothing happened.',
  },
};

const NETWORK_TIMEOUT: TransportReading = {
  code: 'network_timeout',
  message: 'The server did not answer in time.',
  byContext: {
    job:
      'The request was sent, so the run may still be going. Give it a moment ' +
      'and reload before starting another.',
    review:
      'The request was sent, so the save may still have landed. Reload the ' +
      'recording to see what the server holds before typing it again.',
    delete:
      'The request was sent, so the removal may still be running. Reload the ' +
      'list before trying again.',
    default:
      'The request was sent, so it may still be running. Reload before ' +
      'assuming it did not happen.',
  },
};

/** Message fragments the platforms use for a failed fetch. A `TypeError` that
 *  matches none of them is far more likely a bug in our own call than a dead
 *  network, so it is left to degrade as an unknown error rather than be
 *  mislabelled — a wrong diagnosis sends the operator to check a cable that was
 *  never the problem. */
const NETWORK_FETCH_MESSAGES = [
  'failed to fetch', // Chromium
  'networkerror', // Firefox: "NetworkError when attempting to fetch resource."
  'load failed', // Safari
  'network request failed',
  'fetch failed', // undici (Node, and the test runner)
];

/** Duck-typed rather than `instanceof`: a `TimeoutError` is a DOMException,
 *  whose relation to `Error` differs between the browser and the test
 *  environment, and a cross-realm `TypeError` fails `instanceof` outright. */
function errorField(error: unknown, key: 'name' | 'message'): string {
  if (typeof error !== 'object' || error === null) return '';
  const value = (error as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

/** True for the codes minted below — a request that never reached an answer,
 *  as opposed to one the server considered and refused.
 *
 *  Surfaces that announce a refusal have to word themselves differently for
 *  these: "Save refused" over "Could not reach the server" says something
 *  nobody did. Exported so that judgement lives with the codes rather than
 *  being re-derived from their spelling at each call site. */
export function isTransportCode(code: string): boolean {
  return code === NETWORK_UNREACHABLE.code || code === NETWORK_TIMEOUT.code;
}

/** The reading for a failure that never produced an HTTP answer, or null when
 *  the thrown value is not one. */
function readTransportError(
  error: unknown,
  context?: ErrorContext,
): CaptureErrorReading | null {
  const raw = errorField(error, 'message');
  const name = errorField(error, 'name');
  const kind =
    name === 'TimeoutError'
      ? NETWORK_TIMEOUT
      : name === 'TypeError' &&
          NETWORK_FETCH_MESSAGES.some((fragment) => raw.toLowerCase().includes(fragment))
        ? NETWORK_UNREACHABLE
        : null;
  if (!kind) return null;
  return {
    code: kind.code,
    message: kind.message,
    guidance: (context && kind.byContext[context]) || kind.byContext.default,
    severity: 'warning',
    // Deliberately false: `needsReload` drives an automatic refetch, and a
    // screen that cannot reach the server has nothing to refetch WITH. The
    // guidance asks the operator to reload once it is back instead.
    reload: false,
    // The browser's own string is kept for a bug report but not shown — being
    // shown it is the defect this mapping exists to fix.
    details: raw ? { transport_message: raw } : {},
  };
}

/**
 * Read an unknown thrown value as a capture-store error.
 *
 * `capture_busy` is built here rather than in a table because its guidance has
 * to name the job holding the lease (§7.1): "try again later" is useless when
 * the operator cannot see what to wait for, and the payload carries
 * `lease_owner` precisely so the UI can say it.
 */
export function readCaptureError(
  error: unknown,
  context?: ErrorContext,
): CaptureErrorReading {
  if (!(error instanceof ApiError)) {
    return (
      readTransportError(error, context) ?? {
        code: 'unknown',
        message: error instanceof Error ? error.message : String(error),
        guidance: '',
        severity: 'warning',
        reload: false,
        details: {},
      }
    );
  }
  const details = error.details ?? {};
  const code = error.code ?? `http_${error.status}`;

  if (code === 'capture_busy') {
    const owner = detailString(details, 'lease_owner');
    const until = detailString(details, 'lease_expires_at');
    const who = owner
      ? `${owner} is working on this capture${until ? ` until ${until}` : ''}.`
      : 'A job is working on this capture right now.';
    const then =
      context === 'delete'
        ? 'Removing it now would pull the files out from under that job — wait ' +
          'for it to finish, then try again.'
        : context === 'job'
          ? 'Only one job may hold a capture at a time. Wait for that one to ' +
            'finish, then run yours.'
          : 'Wait for it to finish, then try again.';
    return {
      code,
      message: error.message,
      guidance: `${who} ${then}`,
      severity: 'warning',
      reload: false,
      details,
    };
  }

  const contextual = CONTEXTUAL[code];
  if (contextual) {
    return {
      code,
      message: error.message,
      guidance:
        (context && contextual.byContext[context]) || contextual.byContext.default,
      severity: contextual.severity,
      reload: contextual.reload ?? false,
      details,
    };
  }

  const known = GUIDANCE[code];
  return {
    code,
    message: error.message,
    guidance: known?.guidance ?? '',
    severity: known?.severity ?? 'warning',
    reload: known?.reload ?? false,
    details,
  };
}

/**
 * The same reading, reached by CODE instead of by a thrown envelope.
 *
 * Not every failure arrives as an `ApiError`. The dataset archive runner
 * reports a halt as a plain `{code, message}` inside its progress payload
 * (`DatasetArchiveProgress.error`), so the dialog showing it has the code and
 * the server's sentence but nothing to throw — and without this, the guidance
 * for exactly the codes a halt raises is unreachable on the one surface where
 * the operator is stopped and waiting to be told what to do.
 *
 * Reads the same two tables, so a code cannot mean one thing thrown and another
 * reported. What it CANNOT reproduce is the pair built from `details` —
 * `capture_busy` names the job holding the lease, and a plain payload has no
 * lease to name — so those fall through to no guidance rather than to a
 * sentence with a hole in it.
 *
 * An unknown or absent code returns the message with NO guidance: the same
 * degradation an unmapped code gets above, for the same reason.
 */
export function readCaptureCode(
  code: string | null | undefined,
  message: string | null | undefined,
): CaptureErrorReading {
  const resolved = code ?? '';
  const known = GUIDANCE[resolved];
  const contextual = CONTEXTUAL[resolved];
  return {
    code: resolved,
    message: message ?? '',
    guidance: known?.guidance ?? contextual?.byContext.default ?? '',
    severity: known?.severity ?? contextual?.severity ?? 'warning',
    reload: known?.reload ?? contextual?.reload ?? false,
    details: {},
  };
}

/** The one-line form for a toast: the server's message plus what to do. */
export function captureErrorText(error: unknown, context?: ErrorContext): string {
  const reading = readCaptureError(error, context);
  return reading.guidance ? `${reading.message} ${reading.guidance}` : reading.message;
}

/** True when this failure must be surfaced as a destructive-styled, explicitly
 *  dismissed message rather than a passing note (§12). */
export function isDestructiveFailure(error: unknown): boolean {
  return readCaptureError(error).severity === 'destructive';
}

/** True when the client should refetch the capture and let the operator
 *  re-apply the edit (the 409 conflict family). */
export function needsReload(error: unknown): boolean {
  return readCaptureError(error).reload;
}
