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
        'flex shrink-0 flex-col gap-2.5 border-2 border-green-200',
        CARD_GAP_COMPACT,
        CARD_PAD,
      )}
    >
      <div className="flex items-center gap-2">
        <span className="text-[15px] font-bold text-gray-900">
          Batch {machine.batchSeq ?? '—'} completed 🎉
        </span>
        <div className="flex-1" />
        <span className="rounded-chip bg-green-100 px-2 py-0.5 text-[11px] font-bold text-green-700">
          COMPLETE
        </span>
      </div>
      <span className="text-[12.5px] leading-relaxed text-gray-500">
        {endSummary}. Nice work — all {machine.targetEpisodes} episodes recorded.
      </span>
      <button
        type="button"
        data-testid="start-next-set"
        onClick={onStartNextSet}
        className={cn(
          'h-[46px] rounded-control text-sm font-bold text-white',
          confirmNextSet
            ? 'bg-amber-600 hover:bg-amber-700'
            : 'bg-teal-600 hover:bg-teal-700',
        )}
      >
        {confirmNextSet ? 'Press again to start the next set' : 'Start next set'}
      </button>
      {confirmNextSet && (
        <span data-testid="next-set-note" className="text-[11.5px] text-gray-500">
          This panel starts a fresh set — the recorded episodes stay saved in
          Review.
        </span>
      )}
    </Card>
  );
}
