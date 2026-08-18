// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Typed callers for `/api/v1/batches` — Collect's grouping of captures.
//
// A batch groups the captures recorded in one run of a task/condition. There is
// no episodes resource under v2: a capture IS the episode, so a batch's members
// are the captures carrying its `batch_id`, which the FIRST review save stamps
// on (contract §4.1). `POST /api/v1/episodes` is retired along with the
// localStorage bridge that used to stand in for it — a capture now carries its
// own review, so there is nothing left for a browser-local mirror to remember.

import { apiGet, apiPatch, apiPost } from './client';
import type {
  Batch,
  BatchCoverageResponse,
  BatchCoverageScope,
  BatchCreateRequest,
  BatchDetail,
  BatchListResponse,
  BatchLookupResponse,
  BatchPatchRequest,
} from './types';

/** Start a batch (Collect). */
export function createBatch(body: BatchCreateRequest): Promise<Batch> {
  return apiPost<Batch>('/batches', body);
}

/** Early stop, completion, or a project/task/condition relabel. */
export function patchBatch(batchId: string, body: BatchPatchRequest): Promise<Batch> {
  return apiPatch<Batch>(`/batches/${encodeURIComponent(batchId)}`, body);
}

/**
 * Batches newest-first, each with its capture summaries.
 *
 * The filters scope Collect's active-batch restore: without them one terminal
 * can silently adopt — and append captures to — another robot's or operator's
 * batch.
 */
export function listBatches(
  filters: { status?: string; robot?: string; operator?: string } = {},
  signal?: AbortSignal,
): Promise<BatchListResponse> {
  const query: Record<string, string> = {};
  if (filters.status) query.status = filters.status;
  if (filters.robot) query.robot = filters.robot;
  if (filters.operator) query.operator = filters.operator;
  return apiGet<BatchListResponse>('/batches', { signal, query });
}

/** Resolve only the Batch metadata referenced by the current capture page. */
export function lookupBatches(
  batchIds: string[],
  signal?: AbortSignal,
): Promise<BatchLookupResponse> {
  return apiPost<BatchLookupResponse>(
    '/batches/lookup',
    { batch_ids: batchIds },
    { signal },
  );
}

/**
 * Per-condition recorded totals for ONE task, summed in SQL.
 *
 * Collect's Coverage card used to fetch every batch and add them up in the
 * browser — 817 KiB every 30 s at 5000 batches (E-27). Paging that list could
 * not have fixed it: a coverage total computed from one page would be silently
 * short, which is precisely what E-27 is the rule against. So the SUM happens
 * where the rows are.
 *
 * `task` is required (422 without it): a coverage figure spanning tasks would
 * be adding up unrelated work.
 */
export function getBatchCoverage(
  requestedScope: BatchCoverageScope | string,
  signal?: AbortSignal,
): Promise<BatchCoverageResponse> {
  const scope: BatchCoverageScope =
    typeof requestedScope === 'string' ? { task: requestedScope } : requestedScope;
  const query: Record<string, string> = {};
  for (const [name, value] of Object.entries(scope)) {
    if (typeof value === 'string' && value) query[name] = value;
  }
  return apiGet<BatchCoverageResponse>('/batches/coverage', {
    signal,
    query,
  });
}

/** A batch plus its full captures. */
export function getBatch(batchId: string, signal?: AbortSignal): Promise<BatchDetail> {
  return apiGet<BatchDetail>(`/batches/${encodeURIComponent(batchId)}`, { signal });
}
