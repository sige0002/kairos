// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Durable server-owned validation runs. The former browser run store was only
// a useful selection cache; it could not truthfully restore dispatch after a
// reload, so lifecycle state now always comes from these endpoints.

import { apiGet, apiPost, type RequestOptions } from './client';
import type {
  ValidationRun,
  ValidationRunCreateRequest,
  ValidationRunListResponse,
} from './types';

export function createValidationRun(body: ValidationRunCreateRequest): Promise<ValidationRun> {
  return apiPost<ValidationRun>('/validation/runs', body);
}

export function listValidationRuns(
  active: boolean,
  opts: RequestOptions = {},
): Promise<ValidationRunListResponse> {
  return apiGet<ValidationRunListResponse>('/validation/runs', {
    ...opts,
    query: { active: active ? 'true' : 'false' },
  });
}

export function getValidationRun(
  runId: string,
  opts: RequestOptions = {},
): Promise<ValidationRun> {
  return apiGet<ValidationRun>(`/validation/runs/${encodeURIComponent(runId)}`, opts);
}

/** A running child cooperatively stops; cancel_requested is not completion. */
export function cancelValidationRun(runId: string): Promise<ValidationRun> {
  return apiPost<ValidationRun>(`/validation/runs/${encodeURIComponent(runId)}/cancel`, {});
}

/** Retry failures as a new attempt inside the same durable run. */
export function retryValidationRun(runId: string): Promise<ValidationRun> {
  return apiPost<ValidationRun>(
    `/validation/runs/${encodeURIComponent(runId)}/retry-failed`,
    {},
  );
}
