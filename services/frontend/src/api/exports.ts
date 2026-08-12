// Typed callers for the LeRobot export surface (§6.2): a whole dataset
// converted to a LeRobot v3 tree under `exports/`.
//
// The unit is the DATASET — there is no per-capture conversion, so every path
// here is addressed by dataset_id and one dataset has at most one live export.
//
// Two behaviours the callers must know about, because they are contract, not
// implementation:
//
//   * `getExportsConfig` is asked BEFORE any Convert control is rendered. An
//     installation without the exporter overlay answers `enabled: false`, and
//     the control is then not drawn at all rather than drawn and disabled: the
//     honest gate the archive config set the pattern for.
//   * `getDatasetExport` 404s when this orchestrator process knows of no export
//     for the dataset. That is the normal "nothing is converting" answer, not a
//     failure, so it is caught here and returned as `null`. Every other status
//     — including the `failed` a restarted exporter produces — is a real state
//     the UI must show as one.

import { apiGet, apiPost, ApiError } from './client';
import type {
  ExportPreflight,
  ExportRequest,
  ExportStatus,
  ExportSubmitResponse,
  ExportsConfig,
} from './types';

/** Whether this installation can convert at all, and with which profiles. */
export function getExportsConfig(signal?: AbortSignal): Promise<ExportsConfig> {
  return apiGet<ExportsConfig>('/exports/config', { signal });
}

/**
 * What a conversion of *datasetId* with *profile* would do, without doing it:
 * which members come along, which are dropped and why, how the task labels
 * resolve, which captures lack the profile's topics, and where it would land.
 *
 * `memo` participates because it is the last segment of the output name, so
 * the destination preview — and the `output_exists` refusal — follow what the
 * operator is typing.
 */
export function getExportPreflight(
  datasetId: string,
  profile: string,
  memo: string,
  signal?: AbortSignal,
): Promise<ExportPreflight> {
  return apiGet<ExportPreflight>(
    `/datasets/${encodeURIComponent(datasetId)}/export/preflight`,
    { signal, query: { profile, memo: memo || undefined } },
  );
}

/**
 * Start converting the dataset. 202: the conversion runs in the exporter, and
 * `getDatasetExport` is the only window onto it.
 *
 * The refusals are all meaningful and all worth showing verbatim: 409
 * `export_in_progress` / `destination_not_empty` / `profile_invalid` /
 * `export_empty`, and 400 `task_required`. None of them is retryable as-is —
 * each names something the operator changes first.
 */
export function startDatasetExport(
  datasetId: string,
  body: ExportRequest,
): Promise<ExportSubmitResponse> {
  return apiPost<ExportSubmitResponse>(
    `/datasets/${encodeURIComponent(datasetId)}/export`,
    body,
  );
}

/** The dataset's export, or `null` when there is none (404). Polled while a
 *  conversion is live; its own call, not part of the dataset detail, because
 *  it moves every second and the detail does not. */
export async function getDatasetExport(
  datasetId: string,
  signal?: AbortSignal,
): Promise<ExportStatus | null> {
  try {
    return await apiGet<ExportStatus>(
      `/datasets/${encodeURIComponent(datasetId)}/export`,
      { signal },
    );
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

/** Ask the exporter to stop. Answers with the status, same shape as the poll.
 *  Partial output is removed by the exporter — there is nothing half-converted
 *  left behind to clean up, and nothing to resume either. */
export function cancelDatasetExport(datasetId: string): Promise<ExportStatus> {
  return apiPost<ExportStatus>(
    `/datasets/${encodeURIComponent(datasetId)}/export/cancel`,
    undefined,
  );
}
