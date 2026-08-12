// ARMING: the readiness gate is open and the recorder is matching its target
// topics. Recording begins on its own once the recorder confirms, so the only
// control here is the way out.

import { Card, cn } from '../../../components/ui';
import { CARD_PAD } from '../compact';
import type { BatchMachine } from '../useBatchMachine';
import { ArmingNote } from './banners';
import { CARD_GAP_COMPACT } from './shared';

export function ArmingCard({
  machine,
  cancelRef,
  cancelArmed,
}: {
  machine: BatchMachine;
  cancelRef: React.Ref<HTMLButtonElement>;
  /** False for the card's first ARMING_CANCEL_GUARD_MS on screen (#8): Cancel
   *  lands where Start was, and the second press of a double-click must not
   *  back out of the take the first one began. ControlCard owns the timer. */
  cancelArmed: boolean;
}) {
  return (
    <Card
      className={cn(
        'flex shrink-0 flex-col gap-2.5 border-2 border-amber-200',
        CARD_GAP_COMPACT,
        CARD_PAD,
      )}
    >
      <div className="flex items-center gap-2">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-100 border-t-amber-600" />
        <span data-testid="phase-title" className="text-[17px] font-bold text-amber-700">
          ARMING…
        </span>
      </div>
      <span className="text-[12.5px] leading-relaxed text-amber-800">
        Hold still. Recording starts automatically once the recorder confirms.
      </span>
      <button
        ref={cancelRef}
        type="button"
        data-testid="arming-cancel"
        onClick={machine.cancelArming}
        disabled={!cancelArmed}
        className={cn(
          'h-10 rounded-control border border-gray-200 bg-white text-[13px] font-semibold text-gray-500',
          cancelArmed ? 'hover:bg-gray-50' : 'cursor-not-allowed opacity-50',
        )}
      >
        Cancel
      </button>
      {machine.arming && <ArmingNote arming={machine.arming} />}
    </Card>
  );
}
