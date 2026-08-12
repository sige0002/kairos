// PAUSED: the set is held. Nothing is at risk, and the card says so before it
// offers the way back.

import { Card, cn } from '../../../components/ui';
import { CARD_PAD } from '../compact';
import type { BatchMachine } from '../useBatchMachine';
import { CARD_GAP_COMPACT } from './shared';

export function PausedCard({ machine }: { machine: BatchMachine }) {
  return (
    <Card
      className={cn(
        'flex shrink-0 flex-col gap-2.5 border-2 border-gray-200',
        CARD_GAP_COMPACT,
        CARD_PAD,
      )}
    >
      <div className="flex items-center gap-2">
        <span className="h-[9px] w-[9px] rounded-sm bg-gray-400" />
        <h2 data-testid="phase-title" className="text-[17px] font-bold text-gray-500">
          PAUSED
        </h2>
      </div>
      <span className="text-[12.5px] text-gray-500">
        Set is paused. Recorded episodes are safe.
      </span>
      <button
        type="button"
        onClick={machine.resumeBatch}
        className="h-[46px] rounded-control bg-teal-600 text-sm font-bold text-white hover:bg-teal-700"
      >
        Resume set
      </button>
    </Card>
  );
}
