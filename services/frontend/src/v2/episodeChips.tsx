// Shared episode chips + batch-label formatting used by BOTH Review and
// Datasets, so an episode reads identically in every pipeline step (Console v2
// pipeline UX). Honesty: a missing value renders "—", never a fabricated label.

import { Badge, type Tone } from '../components/ui';
import type { Quality, ReviewStatus, TaskResult } from './review/types';

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
