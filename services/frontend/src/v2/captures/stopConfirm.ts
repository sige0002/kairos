// Post-stop confirmation, shared by every caller of POST /record/stop that
// must not walk on until the recorder has actually let go. `/record/stop` is
// idempotent and answers with the LAST capture when it finds nothing active
// (contract §3), so a 200 alone never proves the recorder stopped — Collect's
// SAVING gate and Settings' stop-and-switch both confirm through here.
//
// The confirmation POLLS: a flush takes seconds (rosbag2 drains its cache to
// disk), and inside the recorder's own escalation budget a still-active status
// is normal progress, not a failure. Only the deadline — the full
// SIGINT→SIGTERM→SIGKILL chain plus margin — may call the stop failed.

import { ApiError } from '../../api/client';
import { getRecordStatus } from '../../api/record';
import {
  ACTIVE_RECORD_STATES,
  liveCaptureIds,
  type RecordState,
  type RecordStatus,
} from '../../api/types';
import { STOP_CONFIRM_MAX_MS, STOP_CONFIRM_POLL_MS } from '../pollingPolicy';

let stopConfirmMaxMs: number | null = null;
let stopConfirmPollMs: number | null = null;
/** Test seam (same shape as the stop floor's): the real values live in
 *  pollingPolicy.ts; overriding here lets a test run the confirmation loop in
 *  milliseconds instead of sitting through the 70 s budget. */
export function __setStopConfirmMs(maxMs: number, pollMs: number): void {
  stopConfirmMaxMs = maxMs;
  stopConfirmPollMs = pollMs;
}
export function __resetStopConfirmMs(): void {
  stopConfirmMaxMs = null;
  stopConfirmPollMs = null;
}
export function getStopConfirmMaxMs(defaultMs: number): number {
  return stopConfirmMaxMs ?? defaultMs;
}
export function getStopConfirmPollMs(defaultMs: number): number {
  return stopConfirmPollMs ?? defaultMs;
}

/**
 * Poll `/record/status` until the recorder reports the stop is done, and throw
 * `stop_not_confirmed` only past the escalation budget.
 *
 * `captureId` is the capture the stop answered with; `live_capture_ids` is read
 * as a POSITIVE liveness signal only — an absent array means the recorder is
 * unreachable, not that nothing is live (§10 rev.2.4), so it can never be the
 * thing that says "stopped"; the state field is.
 *
 * A failed status READ is not a failed stop: the recorder's status route
 * shares its finalise lock, so a 503/timeout lands exactly when a large bag is
 * flushing — the very moment this confirmation exists to wait out. Transient
 * errors keep polling; only the deadline surfaces one.
 */
export async function confirmRecorderStopped(
  captureId: string | null,
): Promise<void> {
  const deadline = performance.now() + getStopConfirmMaxMs(STOP_CONFIRM_MAX_MS);
  let lastState: RecordState | null = null;
  for (;;) {
    let status: RecordStatus | null = null;
    try {
      status = await getRecordStatus();
    } catch {
      // Transient — keep polling until the deadline.
    }
    if (status) {
      lastState = status.state;
      const live =
        ACTIVE_RECORD_STATES.has(status.state) ||
        (captureId != null &&
          liveCaptureIds(status)?.includes(captureId) === true);
      if (!live) return;
    }
    if (performance.now() >= deadline) {
      throw new ApiError(
        409,
        {
          error: {
            code: 'stop_not_confirmed',
            message: lastState
              ? `The recorder is still ${lastState}. The recording was not stopped — retry.`
              : 'The recorder did not answer while the stop was being confirmed — retry.',
            details: {},
          },
        },
        'the recorder did not stop',
      );
    }
    await new Promise((resolve) =>
      setTimeout(resolve, getStopConfirmPollMs(STOP_CONFIRM_POLL_MS)),
    );
  }
}
