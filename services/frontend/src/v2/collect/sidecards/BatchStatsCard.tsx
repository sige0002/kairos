// Batch stats: the running tally for the set in progress.

import { Card, cn } from '../../../components/ui';
import type { BatchMachine } from '../useBatchMachine';
import { SIDE_PAD } from '../compact';

export function BatchStatsCard({ machine }: { machine: BatchMachine }) {
  // Quality (good/review) and task result (task failed) are independent axes
  // — a task-failed episode can still count toward "good" quality, since the
  // recording itself is fine and stays usable/labeled data.
  const { nRecorded, nGood, nReview, nTaskFailed } = machine.stats;
  return (
    <Card className={cn('flex shrink-0 flex-col gap-1.5', SIDE_PAD)}>
      <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
        Batch stats
      </span>
      <div className="flex gap-3.5">
        <div className="flex flex-col">
          <span
            data-testid="stat-recorded"
            className="font-mono text-lg font-semibold text-gray-900"
          >
            {nRecorded}
          </span>
          <span className="text-[11px] text-gray-400">recorded</span>
        </div>
        <div className="flex flex-col">
          <span
            data-testid="stat-good"
            className="font-mono text-lg font-semibold text-green-600"
          >
            {nGood}
          </span>
          <span className="text-[11px] text-gray-400">good quality</span>
        </div>
        <div className="flex flex-col">
          <span
            data-testid="stat-review"
            className="font-mono text-lg font-semibold text-amber-600"
          >
            {nReview}
          </span>
          <span className="text-[11px] text-gray-400">needs review</span>
        </div>
        <div className="flex flex-col">
          <span
            data-testid="stat-task-failed"
            className="font-mono text-lg font-semibold text-red-600"
          >
            {nTaskFailed}
          </span>
          <span className="text-[11px] text-gray-400">task failed</span>
        </div>
      </div>
      {/* After a Review delete the monotone "recorded" count outruns the quality
          tallies (which only cover recordings still on disk). Surface that gap
          honestly instead of letting the numbers look inconsistent. */}
      {nRecorded > nGood + nReview && (
        <p
          data-testid="stats-footnote"
          className="text-[11px] leading-snug text-gray-400"
        >
          recorded counts every take this batch; quality tallies reflect recordings
          still on disk
        </p>
      )}
    </Card>
  );
}
