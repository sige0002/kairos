// Typed callers for the capture-store v2 API surface (contract §10). Every
// screen goes through here rather than hand-writing paths, so the retirement of
// /api/v1/runs and /api/v1/episodes is enforced by there being nothing to call.
//
// Two things this module deliberately does NOT do:
//
//   * It never refreshes `views/`. That symlink tree is server-owned and is
//     regenerated automatically after a dataset mutation (§6) — a frontend
//     refresh call would be a second writer racing the one owner.
//   * It never retries a 409. Both 409s here mean "someone else changed this
//     first" (a review conflict, or a job holding the capture lease); the
//     correct response is to reload and let the operator decide, never to
//     re-send and hope.

import { apiDelete, apiGet, apiPatch, apiPost } from './client';
import type {
  ArchiveConfig,
  Capture,
  CaptureArchiveAccepted,
  CaptureArchiveProgress,
  CaptureArchiveRequest,
  CaptureListItem,
  CaptureDeleteRequest,
  CaptureDetail,
  CaptureListParams,
  Dataset,
  DatasetArchiveProgress,
  DatasetArchiveRequest,
  DatasetCreateRequest,
  DatasetDetail,
  DatasetUpdateRequest,
  DatasetListResponse,
  DatasetMember,
  Page,
  ReviewSaveRequest,
  StoreHealth,
  StoreRepairResponse,
} from './types';

/**
 * Max captures the backend will return in one page (routers/captures.py
 * `MAX_LIMIT`; 1001 is a 422).
 *
 * Raised 200 -> 1000 with the server, 2026-08-06. E-27 measured the whole-store
 * walk at 26 sequential round trips against 5,000 captures, and dropping
 * `topics` from the list barely moved the wall clock (settle 4,438 -> 4,288 ms)
 * because the cost was the request COUNT. At 1,000 a page those 26 become 5.
 *
 * Only this walk asks for it. The server's default stays 50, because a page an
 * operator is waiting on must not become a 5,000-row response.
 */
const CAPTURE_PAGE_LIMIT = 1000;

/** Bound on cursor-following, so a pathological catalog cannot spin forever. */
const MAX_PAGES = 50;

function captureQuery(params: CaptureListParams): Record<string, string | number> {
  const query: Record<string, string | number> = {};
  if (params.state) query.state = params.state;
  if (params.review_status) query.review_status = params.review_status;
  if (params.task) query.task = params.task;
  if (params.operator) query.operator = params.operator;
  if (params.robot) query.robot = params.robot;
  if (params.batch) query.batch = params.batch;
  if (params.limit !== undefined) query.limit = params.limit;
  if (params.cursor) query.cursor = params.cursor;
  if (params.include_deleted) query.include_deleted = 'true';
  return query;
}

/** One page of `GET /api/v1/captures` (newest first).
 *
 *  `CaptureListItem`, not `Capture`: the list does not carry `topics` (E-27),
 *  and the type says so rather than leaving callers an `undefined` to find. */
export function listCaptures(
  params: CaptureListParams = {},
  signal?: AbortSignal,
): Promise<Page<CaptureListItem>> {
  return apiGet<Page<CaptureListItem>>('/captures', {
    signal,
    query: captureQuery(params),
  });
}

/**
 * Every capture matching *params*, following the cursor to exhaustion.
 *
 * Review's lane counts and its bulk sets must cover the whole reviewable
 * catalog: a single page silently dropped the tail once the system outgrew it.
 * Pagination is capped at `MAX_PAGES`, and a run into that cap returns what it
 * has along with the unfinished cursor rather than pretending the list is
 * complete.
 */
export async function listAllCaptures(
  params: CaptureListParams = {},
  signal?: AbortSignal,
): Promise<Page<CaptureListItem>> {
  const items: CaptureListItem[] = [];
  let cursor: string | undefined = params.cursor;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res: Page<CaptureListItem> = await listCaptures(
      { ...params, limit: params.limit ?? CAPTURE_PAGE_LIMIT, cursor },
      signal,
    );
    items.push(...res.items);
    if (!res.next_cursor) return { items, next_cursor: null };
    cursor = res.next_cursor;
  }
  return { items, next_cursor: cursor ?? null };
}

/** One capture with its sidecars and reports (404 when unknown). */
export function getCapture(
  captureId: string,
  signal?: AbortSignal,
): Promise<CaptureDetail> {
  return apiGet<CaptureDetail>(`/captures/${encodeURIComponent(captureId)}`, { signal });
}

/**
 * Save a review (§4.1). `base_revision` is a compare-and-swap token, so the
 * three failures a caller must handle are all meaningful:
 *
 *   409 `review_conflict`  — someone saved first; reload and re-apply.
 *   409 `capture_deleting` — the capture is on its way out; the delete won.
 *   500 `review_sidecar_write_failed` — NOTHING was saved and the same
 *       `base_revision` is safe to retry. It must never be swallowed: a silent
 *       failure here reads to the operator as a successful save.
 */
export function saveReview(
  captureId: string,
  body: ReviewSaveRequest,
): Promise<Capture> {
  return apiPatch<Capture>(`/captures/${encodeURIComponent(captureId)}/review`, body);
}

/** Discard or delete a capture (§7). The row survives as a tombstone. */
export function deleteCapture(
  captureId: string,
  body: CaptureDeleteRequest,
): Promise<Capture> {
  return apiPost<Capture>(`/captures/${encodeURIComponent(captureId)}/delete`, body);
}

/** Where this deployment may archive to. Asked BEFORE any archive control is
 *  rendered: with no configured roots the feature is not offered at all. */
export function getArchiveConfig(
  captureId: string,
  signal?: AbortSignal,
): Promise<ArchiveConfig> {
  return apiGet<ArchiveConfig>(
    `/captures/${encodeURIComponent(captureId)}/archive/config`,
    { signal },
  );
}

/** Start archiving a capture out (§6): copy, verify, record, then delete the
 *  source. 202-accepted — the copy runs server-side; poll
 *  `getCaptureArchiveProgress` for the outcome (S2-1). */
export function archiveCapture(
  captureId: string,
  body: CaptureArchiveRequest,
): Promise<CaptureArchiveAccepted> {
  return apiPost<CaptureArchiveAccepted>(
    `/captures/${encodeURIComponent(captureId)}/archive`,
    body,
  );
}

/** Progress of a capture's archive run (`running → complete | failed`). */
export function getCaptureArchiveProgress(
  captureId: string,
  signal?: AbortSignal,
): Promise<CaptureArchiveProgress> {
  return apiGet<CaptureArchiveProgress>(
    `/captures/${encodeURIComponent(captureId)}/archive`,
    { signal },
  );
}

// ---- datasets (§6: rows + ledger events, no directory tree) ---------------

export function listDatasets(signal?: AbortSignal): Promise<DatasetListResponse> {
  return apiGet<DatasetListResponse>('/datasets', { signal });
}

export function getDataset(
  datasetId: string,
  signal?: AbortSignal,
): Promise<DatasetDetail> {
  return apiGet<DatasetDetail>(`/datasets/${encodeURIComponent(datasetId)}`, { signal });
}

export function createDataset(body: DatasetCreateRequest): Promise<Dataset> {
  return apiPost<Dataset>('/datasets', body);
}

/** Edit a dataset's labels (name / operator / task). The views/ tree follows
 *  server-side — the labels are its path. */
export function updateDataset(
  datasetId: string,
  body: DatasetUpdateRequest,
): Promise<Dataset> {
  return apiPatch<Dataset>(`/datasets/${encodeURIComponent(datasetId)}`, body);
}

export function deleteDataset(datasetId: string): Promise<void> {
  return apiDelete(`/datasets/${encodeURIComponent(datasetId)}`);
}

/** Add a capture, allocating the next never-before-issued display_index. */
export function addDatasetMember(
  datasetId: string,
  captureId: string,
): Promise<DatasetMember> {
  return apiPost<DatasetMember>(
    `/datasets/${encodeURIComponent(datasetId)}/members`,
    { capture_id: captureId },
  );
}

/** Remove one member by its membership_id. Its display_index stays retired. */
export function removeDatasetMember(
  datasetId: string,
  membershipId: string,
): Promise<void> {
  return apiDelete(
    `/datasets/${encodeURIComponent(datasetId)}/members/${encodeURIComponent(membershipId)}`,
  );
}

/** Freeze a dataset and start (or resume) copying it out (§6.x). 202: the
 *  copy runs server-side; poll `getDatasetArchive` for the rest. */
export function archiveDataset(
  datasetId: string,
  body: DatasetArchiveRequest,
): Promise<DatasetArchiveProgress> {
  return apiPost<DatasetArchiveProgress>(
    `/datasets/${encodeURIComponent(datasetId)}/archive`,
    body,
  );
}

/** The archive run's progress. Separate from `getDataset` because it is
 *  polled every second and must not churn the detail cache. */
export function getDatasetArchive(
  datasetId: string,
  signal?: AbortSignal,
): Promise<DatasetArchiveProgress> {
  return apiGet<DatasetArchiveProgress>(
    `/datasets/${encodeURIComponent(datasetId)}/archive`,
    { signal },
  );
}

// ---- store health (§8 / §9-3) ---------------------------------------------

export function getStoreHealth(signal?: AbortSignal): Promise<StoreHealth> {
  return apiGet<StoreHealth>('/store/health', { signal });
}

/** Clear SUSPECT after an operator confirms the storage is as it appears.
 *  Refused with 409 `volume_unidentified` while the volume marker is
 *  unreadable — the UI must show that as an explanation, not a generic error. */
export function repairStore(): Promise<StoreRepairResponse> {
  return apiPost<StoreRepairResponse>('/store/repair', undefined);
}
