// SAVING and QUICK CHECK: the two waits between the take ending and its
// result. One card, because the operator has nothing to do in either — only
// the title and the line under it differ.

import { Card, cn } from '../../../components/ui';
import { CARD_PAD } from '../compact';
import type { BatchMachine } from '../useBatchMachine';
import { MachineErrorBanner } from './banners';
import { CARD_GAP_COMPACT } from './shared';

export function SavingCard({
  machine,
  phase,
  titleRef,
}: {
  machine: BatchMachine;
  phase: 'saving' | 'quickcheck';
  titleRef: React.Ref<HTMLSpanElement>;
}) {
  const saving = phase === 'saving';
  return (
    <Card
      className={cn(
        'flex shrink-0 flex-col gap-2.5 border-2 border-gray-200',
        CARD_GAP_COMPACT,
        CARD_PAD,
      )}
    >
      <div className="flex items-center gap-2">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-100 border-t-teal-600" />
        <span
          ref={titleRef}
          data-testid="phase-title"
          tabIndex={-1}
          aria-live="polite"
          className="text-[17px] font-bold text-gray-700 outline-none"
        >
          {saving ? 'SAVING…' : 'QUICK CHECK…'}
        </span>
      </div>
      <span className="text-[12.5px] leading-relaxed text-gray-500">
        {saving
          ? 'Finalizing the recording…'
          : 'Reading recorded counts, gaps and integrity.'}
      </span>
      {/* Indeterminate progress — the real duration isn't known, so no fake %. */}
      <div className="h-1.5 overflow-hidden rounded-full bg-gray-100">
        <span className="block h-full w-1/3 animate-pulse rounded-full bg-teal-500" />
      </div>
      {machine.stopError && (
        <>
          <MachineErrorBanner label="Stop failed" error={machine.stopError} />
          <button
            type="button"
            onClick={machine.retryStop}
            className="h-10 rounded-control bg-red-600 text-[13px] font-bold text-white hover:bg-red-700"
          >
            Retry stop
          </button>
        </>
      )}
    </Card>
  );
}
