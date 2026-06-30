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
 * Pull a short, human "why" from an ApiError's `details` — the deeper cause the
 * backend attaches (e.g. a failed dataset_export job's `reason`). Returned only
 * when it adds information beyond the message itself, so we never echo it twice.
 */
function detailText(err: unknown): string | null {
  if (!(err instanceof ApiError) || !err.details) return null;
  const d = err.details;
  const reason = d.reason ?? d.detail;
  if (typeof reason !== 'string' || !reason.trim()) return null;
  return err.message.includes(reason) ? null : reason;
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
