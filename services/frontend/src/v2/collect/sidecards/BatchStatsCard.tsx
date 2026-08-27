// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
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
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-muted">
        Batch stats
      </h2>
      <div className="flex gap-3.5">
        <div className="flex flex-col">
          <span
            data-testid="stat-recorded"
            className="font-mono text-lg font-semibold text-text-primary"
          >
            {nRecorded}
          </span>
          <span className="text-[11px] text-text-muted">recorded</span>
        </div>
        <div className="flex flex-col">
          <span
            data-testid="stat-good"
            className="font-mono text-lg font-semibold text-status-success-text"
          >
            {nGood}
          </span>
          <span className="text-[11px] text-text-muted">good quality</span>
        </div>
        <div className="flex flex-col">
          <span
            data-testid="stat-review"
            className="font-mono text-lg font-semibold text-status-warning-text"
          >
            {nReview}
          </span>
          <span className="text-[11px] text-text-muted">needs review</span>
        </div>
        <div className="flex flex-col">
          <span
            data-testid="stat-task-failed"
            className="font-mono text-lg font-semibold text-status-danger-text"
          >
            {nTaskFailed}
          </span>
          <span className="text-[11px] text-text-muted">task failed</span>
        </div>
      </div>
      {/* After a Review delete the monotone "recorded" count outruns the quality
          tallies (which only cover recordings still on disk). Surface that gap
          honestly instead of letting the numbers look inconsistent. */}
      {nRecorded > nGood + nReview && (
        <p
          data-testid="stats-footnote"
          className="text-[11px] leading-snug text-text-muted"
        >
          recorded counts every take this batch; quality tallies reflect recordings
          still on disk
        </p>
      )}
    </Card>
  );
}
