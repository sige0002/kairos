// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// A refused pipeline job, in the voice of the action that failed.
//
// Job submission shares three codes with the review and removal flows —
// `capture_busy`, `capture_deleting`, `capture_deleted` — and the right next
// step is not the same for all three. errors.ts holds the per-context wording;
// this renders it. A bare <ErrorMessage> shows only the server's sentence,
// which for a job says nothing about what the operator should do now.
//
// The note also carries two things a failed ATTEMPT needs that a refusal alone
// does not (#9). Every screen that shows one of these sits beside a result the
// server stored earlier — a PASS badge, a loss table, an integrity report — and
// a failed attempt neither replaces nor annotates it, so the two read as one
// statement: a stale PASS with "Failed to fetch" under it. `staleNote` is the
// caller's sentence saying which of the two the reader is looking at, and
// `onRetry` puts the way forward in the same place as the news, instead of
// leaving the operator to find the button that failed.

import { readCaptureError } from './errors';

export function JobErrorNote({
  error,
  testId = 'job-error',
  staleNote,
  onRetry,
  retryLabel = 'Retry',
  retryDisabled = false,
}: {
  error: unknown;
  testId?: string;
  /** What the result still on screen actually is, given this attempt failed.
   *  Pass it only when there IS one — claiming a stored result that does not
   *  exist would be the same lie in the other direction. */
  staleNote?: string;
  /** Re-runs the same work. Omit where a retry cannot help (no template
   *  configured, the capture already gone) rather than offering a dead button. */
  onRetry?: () => void;
  retryLabel?: string;
  retryDisabled?: boolean;
}) {
  if (!error) return null;
  const reading = readCaptureError(error, 'job');
  return (
    <div
      role="alert"
      data-testid={testId}
      data-error-code={reading.code}
      className="flex flex-col gap-1.5 rounded-control border border-status-danger-border bg-status-danger-bg px-3 py-2 text-[11.5px] leading-relaxed text-status-danger-text"
    >
      <p>
        <span className="font-semibold">{reading.message}</span>
        {reading.guidance && <> {reading.guidance}</>}
      </p>
      {staleNote && (
        <p data-testid={`${testId}-stale`} className="text-status-danger-text">
          {staleNote}
        </p>
      )}
      {onRetry && (
        <button
          type="button"
          data-testid={`${testId}-retry`}
          onClick={onRetry}
          disabled={retryDisabled}
          className="self-start rounded-control border border-status-danger-border bg-surface px-2.5 py-1 font-semibold text-status-danger-text transition-colors hover:bg-status-danger-bg disabled:opacity-50"
        >
          {retryLabel}
        </button>
      )}
    </div>
  );
}

/** Codes that mean the capture itself is on its way out or already gone, so a
 *  screen holding it should re-read rather than keep offering live controls. */
const TOMBSTONE_CODES = new Set(['capture_deleting', 'capture_deleted']);

export function isTombstoneError(error: unknown): boolean {
  return TOMBSTONE_CODES.has(readCaptureError(error).code);
}
