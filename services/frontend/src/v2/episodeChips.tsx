// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Shared label chips used by BOTH Review and Datasets, so a recording reads
// identically at every pipeline step (Console v2 pipeline UX).
//
// They now read a `CaptureListItem` directly: v2 merged the run and the episode, so the
// review fields the chips render live on the capture itself and there is no
// separate episode object to pass around. Honesty rule unchanged — a missing
// value renders "—", never a fabricated label.

import type { CaptureListItem, Quality, TaskResult } from '../api/types';
import { Badge, type Tone } from '../components/ui';
import { formatShortDate } from '../i18n/format';
import { i18n } from '../i18n';
import type { ReviewLane } from './review/types';

// Presentation vocabulary is deliberately kept at the rendering boundary.
// The rest of v2 carries the API's stable codes (`good`, `needs_review`, …).
export function qualityLabel(q: Quality | null | undefined): string | null {
  if (q === 'good') return i18n.t('common:status.good');
  if (q === 'needs_review') return i18n.t('common:status.needsReview');
  return q === 'not_usable' ? i18n.t('common:status.notUsable') : null;
}
export function taskResultLabel(t: TaskResult | null | undefined): string | null {
  if (t === 'success') return i18n.t('common:status.success');
  return t === 'failure' ? i18n.t('common:status.failure') : null;
}

const LANE_TONE: Record<ReviewLane, Tone> = {
  ready: 'green',
  needs_check: 'amber',
  excluded: 'red',
};

/** Exception-review lane chip (READY / NEEDS CHECK / EXCLUDED) — the primary
 *  status vocabulary shared across Review and Datasets. */
export function LaneChip({ lane, testId }: { lane: ReviewLane; testId?: string }) {
  return (
    <span data-testid={testId} className="w-fit">
      <Badge tone={LANE_TONE[lane]} className="w-fit whitespace-nowrap">
        {lane === 'ready'
          ? i18n.t('common:status.ready')
          : lane === 'needs_check'
            ? i18n.t('common:status.needsCheck')
            : i18n.t('common:status.excluded')}
      </Badge>
    </span>
  );
}

export function qualityTone(q: Quality): Tone {
  if (q === 'good') return 'green';
  if (q === 'needs_review') return 'amber';
  return 'red';
}

export function QualityChip({ quality }: { quality: Quality | null }) {
  if (!quality) return <span className="font-mono text-xs text-text-muted">—</span>;
  return (
    <Badge tone={qualityTone(quality)} className="w-fit whitespace-nowrap">
      {qualityLabel(quality)!.toUpperCase()}
    </Badge>
  );
}

export function TaskResultChip({
  task,
  reason,
}: {
  task: TaskResult | null;
  /** The operator's failure reason (`failure_reason`) — surfaces as the FAILURE
   *  chip's tooltip so the WHY is one hover away wherever the chip appears. */
  reason?: string | null;
}) {
  if (!task) return <span className="font-mono text-xs text-text-muted">—</span>;
  const title =
    task === 'failure' && reason
      ? i18n.t('common:status.failureReason', { reason })
      : undefined;
  return (
    <span title={title} className="w-fit">
      <Badge
        tone={task === 'success' ? 'teal' : 'gray'}
        className="w-fit whitespace-nowrap"
      >
        {taskResultLabel(task)!.toUpperCase()}
      </Badge>
    </span>
  );
}

/** "MM/DD · #N" from a server batch_seq. A null seq yields `fallback`
 *  (default "—"): the batch number is the server's to assign, and a capture
 *  reviewed into no batch genuinely has none. */
export function formatBatchLabel(
  batchSeq: number | null | undefined,
  isoDate?: string | null,
  fallback = '—',
): string {
  if (batchSeq == null) return fallback;
  const d = isoDate ? new Date(isoDate) : null;
  const datePart = d && !Number.isNaN(d.getTime()) ? `${formatShortDate(d)} · ` : '';
  return `${datePart}#${batchSeq}`;
}

export function BatchChip({
  batchSeq,
  isoDate,
  fallback,
}: {
  batchSeq: number | null | undefined;
  isoDate?: string | null;
  fallback?: string;
}) {
  return (
    <Badge tone="gray" mono className="w-fit whitespace-nowrap">
      {formatBatchLabel(batchSeq, isoDate, fallback ?? '—')}
    </Badge>
  );
}

/**
 * The label chips for one capture (batch · task-result · quality).
 *
 * `batchSeq` is passed in rather than read off the capture: the capture carries
 * the batch_id, but the human-readable per-day number lives on the batch, so
 * only a caller that loaded the batch can supply it. Absent, the batch chip
 * says "—" instead of inventing a number.
 */
export function CaptureLabelChips({
  capture,
  batchSeq,
  isoFallback,
  testId,
}: {
  capture: CaptureListItem;
  batchSeq?: number | null;
  isoFallback?: string | null;
  testId?: string;
}) {
  return (
    <div data-testid={testId} className="flex flex-wrap items-center gap-1.5">
      <BatchChip batchSeq={batchSeq} isoDate={isoFallback ?? capture.started_at} />
      <TaskResultChip
        task={capture.task_result ?? null}
        reason={capture.failure_reason}
      />
      <QualityChip quality={capture.quality ?? null} />
    </div>
  );
}
