// A refused pipeline job, in the voice of the action that failed.
//
// Job submission shares three codes with the review and removal flows —
// `capture_busy`, `capture_deleting`, `capture_deleted` — and the right next
// step is not the same for all three. errors.ts holds the per-context wording;
// this renders it. A bare <ErrorMessage> shows only the server's sentence,
// which for a job says nothing about what the operator should do now.

import { readCaptureError } from './errors';

export function JobErrorNote({
  error,
  testId = 'job-error',
}: {
  error: unknown;
  testId?: string;
}) {
  if (!error) return null;
  const reading = readCaptureError(error, 'job');
  return (
    <p
      role="alert"
      data-testid={testId}
      data-error-code={reading.code}
      className="rounded-control border border-red-200 bg-red-50 px-3 py-2 text-[11.5px] leading-relaxed text-red-700"
    >
      <span className="font-semibold">{reading.message}</span>
      {reading.guidance && <> {reading.guidance}</>}
    </p>
  );
}

/** Codes that mean the capture itself is on its way out or already gone, so a
 *  screen holding it should re-read rather than keep offering live controls. */
const TOMBSTONE_CODES = new Set(['capture_deleting', 'capture_deleted']);

export function isTombstoneError(error: unknown): boolean {
  return TOMBSTONE_CODES.has(readCaptureError(error).code);
}
