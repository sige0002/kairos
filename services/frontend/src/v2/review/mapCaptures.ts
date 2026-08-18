// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Maps captures into Review rows.
//
// Everything comes from the capture: v2 merged the run and the episode, so
// quality, task result, batch grouping and adopt/exclude are fields on the row
// the API already returned. There is no second source to reconcile, and no
// browser-local bridge — the localStorage mirror that stood in for a missing
// server model was superseded along with `/api/v1/episodes`.
//
// One rule overrides the review: a capture that ended `failed` or `interrupted`
// is "Not usable" whatever its review says. That is the backend's own verdict
// about whether the recording finished, and no label an operator applies can
// make an incomplete bag usable — so a stale or optimistic review must never be
// able to mask it.
//
// Captures still being written (`recording`/`stopping`) and tombstones
// (`delete_pending`/`discarded`/`deleted`) are excluded: there is nothing to
// review until a recording has finished, and nothing to decide once it is gone.
//
// The episode number is the server's `index_in_batch` (§8) or NOTHING. It used
// to fall back to the row's position, which produced a number the server had
// never issued: it read as a fact, and it could collide head-on with a real
// index_in_batch on a neighbouring row, so two different rows showed "#1" and
// neither was wrong-looking. A capture the server gave no index has no episode
// number, and the row renders "—" like every other unknown.

import type { CaptureListItem } from '../../api/types';
import {
  resolveCaptureCondition,
  type LegacyConditionLookup,
} from '../captures/recordingCondition';
import { displayQuality, displayTaskResult, formatBatchLabel } from '../episodeChips';
import { serverTransferPhase } from './transfer';
import type { DisplayQuality, DisplayTaskResult, EpisodeRow } from './types';

/** CaptureListItem states that can be reviewed: finished, one way or another. */
const REVIEWABLE = new Set(['completed', 'failed', 'interrupted']);

/** Milliseconds between two ISO instants (undefined when indeterminate).
 *  Exported for the Datasets rows, which cite the same duration. */
export function spanMs(
  started?: string | null,
  ended?: string | null,
): number | undefined {
  if (!started || !ended) return undefined;
  const s = Date.parse(started);
  const e = Date.parse(ended);
  if (Number.isNaN(s) || Number.isNaN(e) || e < s) return undefined;
  return e - s;
}

/** The human-readable batch number, keyed by batch_id. Only a caller that
 *  loaded the batches can supply it; without one the row shows "—" rather than
 *  inventing a number. */
export type BatchSeqLookup = (batchId: string | null | undefined) => {
  seq: number | null;
  createdAt: string | null;
  condition?: string | null;
} | null;

export function mapCapturesToEpisodes(
  captures: CaptureListItem[],
  batchSeq: BatchSeqLookup = () => null,
  legacyBatchStatus: 'loading' | 'unavailable' = 'unavailable',
): EpisodeRow[] {
  const reviewable = captures.filter((c) => REVIEWABLE.has(c.state));
  // Oldest first: the table reads in recording order, which is the order an
  // operator reviews a session in. `started_at` is the key — never `ep`, which
  // a capture may not have at all — and capture_id (UUIDv7, so its lexical
  // order IS its creation order) is the tiebreak when a capture has no
  // started_at.
  const ordered = [...reviewable].sort((a, b) => {
    const ta = a.started_at ? Date.parse(a.started_at) : NaN;
    const tb = b.started_at ? Date.parse(b.started_at) : NaN;
    if (!Number.isNaN(ta) && !Number.isNaN(tb)) return ta - tb;
    return a.capture_id.localeCompare(b.capture_id);
  });

  return ordered.map((capture) => {
    const endedBadly = capture.state === 'failed' || capture.state === 'interrupted';
    let quality: DisplayQuality | null;
    let task: DisplayTaskResult | null;
    let failReason: string | null;
    if (endedBadly) {
      quality = 'Not usable';
      task = null;
      failReason = null;
    } else {
      quality = displayQuality(capture.quality);
      task = displayTaskResult(capture.task_result);
      failReason = capture.failure_reason ?? null;
    }

    const batch = batchSeq(capture.batch_id);
    const legacyCondition: LegacyConditionLookup = !capture.batch_id
      ? { status: 'ready', value: null }
      : batch
        ? { status: 'ready', value: batch.condition }
        : { status: legacyBatchStatus };
    const condition = resolveCaptureCondition(capture, legacyCondition);
    return {
      ep: capture.index_in_batch ?? null,
      captureId: capture.capture_id,
      runId: capture.run_id ?? null,
      reviewRevision: capture.review_revision,
      state: capture.state,
      batch: formatBatchLabel(batch?.seq, batch?.createdAt ?? capture.started_at, '—'),
      batchId: capture.batch_id ?? null,
      condition: condition.status === 'ready' ? condition.value : null,
      conditionStatus: condition.status,
      operator: capture.operator ?? null,
      quality,
      task,
      failReason,
      reviewStatus: capture.review_status,
      durationMs: spanMs(capture.started_at, capture.ended_at),
      startedAt: capture.started_at ?? undefined,
      bytes: capture.bytes ?? null,
      issues: endedBadly ? 'Recording did not complete cleanly' : null,
      transfer: serverTransferPhase(capture),
      capture,
    };
  });
}
