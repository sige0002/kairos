import { ApiError } from '../api/client';

/**
 * The human sentence for an error — what happened, in words.
 *
 * The raw code is deliberately NOT prefixed here. Leading with
 * `capture_deleted: …` puts an identifier the operator did not ask for in front
 * of the one part they can read; the code still travels, on its own muted line
 * (see `ErrorMessage`), so it remains quotable in a bug report without being
 * the first thing anyone meets.
 */
export function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** The machine-readable code, for the muted trailing line. Null when the error
 *  carries none (a transport failure, a thrown string). */
export function errorCode(err: unknown): string | null {
  return err instanceof ApiError ? (err.code ?? null) : null;
}

/**
 * Pull the GENERIC deeper cause out of an ApiError's `details`.
 *
 * `cause` is the only key that means this and the only one any endpoint can
 * attach: the orchestrator sets it when a downstream service could not be
 * reached at all, where the message says which service and `cause` says what
 * the transport actually did.
 *
 * PER-CODE details are deliberately NOT read here — `capture_busy`'s
 * `lease_owner`, `review_conflict`'s revisions, and the rest are turned into
 * operator guidance by v2/captures/errors.ts, which knows what each code means.
 * Widening this function to guess at them would produce a second, dumber
 * rendering of the same payload, and would make that special-casing look
 * redundant enough to delete.
 *
 * Returned only when it adds information beyond the message itself, so the same
 * sentence is never echoed twice.
 */
function detailText(err: unknown): string | null {
  if (!(err instanceof ApiError) || !err.details) return null;
  const cause = err.details.cause;
  if (typeof cause !== 'string' || !cause.trim()) return null;
  return err.message.includes(cause) ? null : cause;
}

/** Plain sentence first, deeper cause next, raw code last and muted — the same
 *  order the recorder's failed-start banner uses, so every error on screen
 *  reads the same way round. */
export function ErrorMessage({ error }: { error: unknown }) {
  const detail = detailText(error);
  const code = errorCode(error);
  return (
    <div
      role="alert"
      data-error-code={code ?? undefined}
      className="rounded bg-red-50 px-3 py-2 text-sm text-red-700"
    >
      <p>{errorText(error)}</p>
      {detail && <p className="mt-1 font-mono text-xs text-red-600">{detail}</p>}
      {code && <p className="mt-0.5 font-mono text-xs text-red-600 opacity-70">({code})</p>}
    </div>
  );
}
