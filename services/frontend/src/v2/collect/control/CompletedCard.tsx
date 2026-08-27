// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// COMPLETED: the set hit its target. Same summary and same next-set control as
// ENDED, in the one green frame the screen ever shows.

import { Card, cn } from '../../../components/ui';
import { CARD_PAD } from '../compact';
import type { BatchMachine } from '../useBatchMachine';
import { CARD_GAP_COMPACT, formatEndSummary } from './shared';

export function CompletedCard({
  machine,
  confirmNextSet,
  onStartNextSet,
}: {
  machine: BatchMachine;
  confirmNextSet: boolean;
  onStartNextSet: () => void;
}) {
  const endSummary = formatEndSummary(machine.stats);
  return (
    <Card
      className={cn(
        'flex shrink-0 flex-col gap-2.5 border-2 border-status-success-border',
        CARD_GAP_COMPACT,
        CARD_PAD,
      )}
    >
      <div className="flex items-center gap-2">
        <h2 className="text-[15px] font-bold text-text-primary">
          Batch {machine.batchSeq ?? '—'} completed 🎉
        </h2>
        <div className="flex-1" />
        <span className="rounded-chip bg-status-success-bg px-2 py-0.5 text-[11px] font-bold text-status-success-text">
          COMPLETE
        </span>
      </div>
      <span className="text-[12.5px] leading-relaxed text-text-muted">
        {endSummary}. Nice work — all {machine.targetEpisodes} episodes recorded.
      </span>
      <button
        type="button"
        data-testid="start-next-set"
        onClick={onStartNextSet}
        className={cn(
          'h-[46px] rounded-control text-sm font-bold',
          confirmNextSet
            ? 'bg-status-warning-accent text-status-warning-contrast hover:opacity-90'
            : 'bg-accent text-text-inverse hover:bg-accent-strong',
        )}
      >
        {confirmNextSet ? 'Press again to start the next set' : 'Start next set'}
      </button>
      {confirmNextSet && (
        <span data-testid="next-set-note" className="text-[11.5px] text-text-muted">
          This panel starts a fresh set — the recorded episodes stay saved in
          Review.
        </span>
      )}
    </Card>
  );
}
