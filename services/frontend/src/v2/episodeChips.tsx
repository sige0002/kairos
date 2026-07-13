// Shared episode chips + batch-label formatting used by BOTH Review and
// Datasets, so an episode reads identically in every pipeline step (Console v2
// pipeline UX). Honesty: a missing value renders "—", never a fabricated label.

import type { RunEpisode } from '../api/types';
import { Badge, type Tone } from '../components/ui';
import type { Quality, ReviewLane, ReviewStatus, TaskResult } from './review/types';

// Server episode enums (api/types) → the Review display vocabulary the chips
// speak. Kept here so every surface that renders an episode (Review, Datasets)
// maps identically.
const QUALITY_FROM_SERVER: Record<RunEpisode['quality'], Quality> = {
  good: 'Good',
  needs_review: 'Needs review',
  not_usable: 'Not usable',
};
const TASK_FROM_SERVER: Record<RunEpisode['task_result'], TaskResult> = {
  success: 'Success',
  failure: 'Failure',
};

const LANE_TONE: Record<ReviewLane, Tone> = { ready: 'green', needs_check: 'amber', excluded: 'red' };
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

function qualityTone(q: Quality): Tone {
  if (q === 'Good') return 'green';
  if (q === 'Needs review') return 'amber';
  return 'red';
}

export function QualityChip({ quality }: { quality: Quality | null }) {
  if (!quality) return <span className="font-mono text-xs text-gray-400">—</span>;
  return (
    <Badge tone={qualityTone(quality)} className="w-fit whitespace-nowrap">
      {quality.toUpperCase()}
    </Badge>
  );
}

export function TaskResultChip({ task }: { task: TaskResult | null }) {
  if (!task) return <span className="font-mono text-xs text-gray-400">—</span>;
  return (
    <Badge tone={task === 'Success' ? 'teal' : 'gray'} className="w-fit whitespace-nowrap">
      {task.toUpperCase()}
    </Badge>
  );
}

const REVIEW_STATUS_TONE: Record<ReviewStatus, Tone> = {
  adopted: 'green',
  excluded: 'red',
  pending: 'gray',
};

export function ReviewStatusChip({
  status,
  testId,
}: {
  status: ReviewStatus;
  testId?: string;
}) {
  return (
    <span data-testid={testId} className="w-fit">
      <Badge tone={REVIEW_STATUS_TONE[status]} className="w-fit whitespace-nowrap">
        {status.toUpperCase()}
      </Badge>
    </span>
  );
}

/** "MM/DD · #N" from a server batch_seq (Review/Datasets share this). A null seq
 *  yields the `fallback` (default "—") — the bridge's local number or nothing. */
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

/** The label chips for one episode (batch · task-result · quality), read from a
 *  server `RunEpisode`. Used wherever an exported/recorded episode is listed
 *  (Datasets catalog card + detail). Render this ONLY when an episode is present
 *  — callers show nothing (no fabricated labels) when it is null/absent. */
export function EpisodeLabelChips({
  episode,
  isoFallback,
  testId,
}: {
  episode: RunEpisode;
  /** Date used for the batch chip when the episode carries no batch_created_at. */
  isoFallback?: string | null;
  testId?: string;
}) {
  return (
    <div data-testid={testId} className="flex flex-wrap items-center gap-1.5">
      <BatchChip batchSeq={episode.batch_seq} isoDate={episode.batch_created_at ?? isoFallback} />
      <TaskResultChip task={TASK_FROM_SERVER[episode.task_result]} />
      <QualityChip quality={QUALITY_FROM_SERVER[episode.quality]} />
    </div>
  );
}
