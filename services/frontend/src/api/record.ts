// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Recording control (contract §3): the four calls that arm, start, stop and
// observe a take.
//
// `/record/stop` is idempotent and answers with the LAST capture when it finds
// nothing active, so a 200 here is not on its own proof that the recorder
// stopped — callers that need certainty confirm against `getRecordStatus`.

import { apiGet, apiPost, type RequestOptions } from './client';
import type {
  Capture,
  RecordPrepareResponse,
  RecordStartRequest,
  RecordStatus,
} from './types';

// Budgets beyond the client's 30 s default deadline (S3-8), matched to the
// server's own: the orchestrator waits out the recorder's config-derived start
// waits (S2-3, ≥25 s) and a stop's full SIGINT→SIGKILL escalation (~75 s).
// Cutting either off CLIENT-side before the server's own budget would refuse
// an operation that was still legitimately succeeding.
const START_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 90_000;

export function startRecord(body: RecordStartRequest): Promise<Capture> {
  return apiPost<Capture>('/record/start', body, { timeoutMs: START_TIMEOUT_MS });
}

/** Two-phase start: spawn + subscribe now, paused, so the eventual start is a
 *  near-instant resume. Absent on an older recorder — callers treat a failure
 *  as "no pre-arm available" rather than surfacing it. */
export function prepareRecord(
  body: RecordStartRequest,
): Promise<RecordPrepareResponse> {
  // Same budget as start: a prepare blocks through the same recorder waits.
  return apiPost<RecordPrepareResponse>('/record/prepare', body, {
    timeoutMs: START_TIMEOUT_MS,
  });
}

export function stopRecord(): Promise<Capture> {
  return apiPost<Capture>('/record/stop', {}, { timeoutMs: STOP_TIMEOUT_MS });
}

export function getRecordStatus(opts: RequestOptions = {}): Promise<RecordStatus> {
  return apiGet<RecordStatus>('/record/status', opts);
}
