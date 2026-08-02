import { ApiError } from '../api/client';

/** Render an error (ApiError or anything) into a consistent, readable string. */
export function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    return err.code ? `${err.code}: ${err.message}` : err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
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

export function ErrorMessage({ error }: { error: unknown }) {
  const detail = detailText(error);
  return (
    <div role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">
      <p>{errorText(error)}</p>
      {detail && <p className="mt-1 font-mono text-xs text-red-600">{detail}</p>}
    </div>
  );
}
