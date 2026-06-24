import { ApiError } from '../api/client';

/** Render an error (ApiError or anything) into a consistent, readable string. */
export function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    return err.code ? `${err.code}: ${err.message}` : err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

export function ErrorMessage({ error }: { error: unknown }) {
  return (
    <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">
      {errorText(error)}
    </p>
  );
}
