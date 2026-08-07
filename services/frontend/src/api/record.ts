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

export function startRecord(body: RecordStartRequest): Promise<Capture> {
  return apiPost<Capture>('/record/start', body);
}

/** Two-phase start: spawn + subscribe now, paused, so the eventual start is a
 *  near-instant resume. Absent on an older recorder — callers treat a failure
 *  as "no pre-arm available" rather than surfacing it. */
export function prepareRecord(
  body: RecordStartRequest,
): Promise<RecordPrepareResponse> {
  return apiPost<RecordPrepareResponse>('/record/prepare', body);
}

export function stopRecord(): Promise<Capture> {
  return apiPost<Capture>('/record/stop', {});
}

export function getRecordStatus(opts: RequestOptions = {}): Promise<RecordStatus> {
  return apiGet<RecordStatus>('/record/status', opts);
}
