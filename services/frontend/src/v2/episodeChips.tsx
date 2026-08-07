// Shared label chips used by BOTH Review and Datasets, so a recording reads
// identically at every pipeline step (Console v2 pipeline UX).
//
// They now read a `CaptureListItem` directly: v2 merged the run and the episode, so the
// review fields the chips render live on the capture itself and there is no
// separate episode object to pass around. Honesty rule unchanged — a missing
// value renders "—", never a fabricated label.

import type { CaptureListItem, Quality, TaskResult } from '../api/types';
import { Badge, type Tone } from '../components/ui';
import type {
  DisplayQuality,
  DisplayTaskResult,
  ReviewLane,
} from './review/types';

// Server vocabulary -> the display vocabulary the chips speak. Kept here so
// every surface that renders a capture's labels maps identically.
const QUALITY_FROM_SERVER: Record<Quality, DisplayQuality> = {
  good: 'Good',
  needs_review: 'Needs review',
  not_usable: 'Not usable',
};
const TASK_FROM_SERVER: Record<TaskResult, DisplayTaskResult> = {
  success: 'Success',
  failure: 'Failure',
};

export function displayQuality(q: Quality | null | undefined): DisplayQuality | null {
  return q ? QUALITY_FROM_SERVER[q] : null;
}
export function displayTaskResult(
  t: TaskResult | null | undefined,
): DisplayTaskResult | null {
  return t ? TASK_FROM_SERVER[t] : null;
}

const LANE_TONE: Record<ReviewLane, Tone> = {
  ready: 'green',
  needs_check: 'amber',
  excluded: 'red',
};
const LANE_LABEL: Record<ReviewLane, string> = {
  ready: 'READY',
  needs_check: 'NEEDS CHECK',
  excluded: 'EXCLUDED',
};

/** Exception-review lane chip (READY / NEEDS CHECK / EXCLUDED) — the primary
 *  status vocabulary shared across Review and Datasets. */
export function LaneChip({ lane, testId }: { lane: ReviewLane; testId?: string }) {
  return (
    <span data-testid={testId} className="w-fit">
      <Badge tone={LANE_TONE[lane]} className="w-fit whitespace-nowrap">
        {LANE_LABEL[lane]}
      </Badge>
    </span>
  );
}

function qualityTone(q: DisplayQuality): Tone {
  if (q === 'Good') return 'green';
  if (q === 'Needs review') return 'amber';
  return 'red';
}

export function QualityChip({ quality }: { quality: DisplayQuality | null }) {
  if (!quality) return <span className="font-mono text-xs text-gray-400">—</span>;
  return (
    <Badge tone={qualityTone(quality)} className="w-fit whitespace-nowrap">
      {quality.toUpperCase()}
    </Badge>
  );
}

export function TaskResultChip({
  task,
  reason,
}: {
  task: DisplayTaskResult | null;
  /** The operator's failure reason (`failure_reason`) — surfaces as the FAILURE
   *  chip's tooltip so the WHY is one hover away wherever the chip appears. */
  reason?: string | null;
}) {
  if (!task) return <span className="font-mono text-xs text-gray-400">—</span>;
  const title = task === 'Failure' && reason ? `Failure reason: ${reason}` : undefined;
  return (
    <span title={title} className="w-fit">
      <Badge
        tone={task === 'Success' ? 'teal' : 'gray'}
        className="w-fit whitespace-nowrap"
      >
        {task.toUpperCase()}
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
  const datePart =
    d && !Number.isNaN(d.getTime())
      ? `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} · `
      : '';
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
        task={displayTaskResult(capture.task_result)}
        reason={capture.failure_reason}
      />
      <QualityChip quality={displayQuality(capture.quality)} />
    </div>
  );
}
