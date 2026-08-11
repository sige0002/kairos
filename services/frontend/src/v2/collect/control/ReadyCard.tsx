// READY: the pre-take card. Start is the only primary action, and it is gated
// on the two things a recording cannot be made without — at least one topic,
// and an operator who owns it.

import { Card, cn } from '../../../components/ui';
import { CARD_PAD } from '../compact';
import type { BatchMachine } from '../useBatchMachine';
import { MachineErrorBanner } from './banners';
import { CARD_GAP_COMPACT } from './shared';

export function ReadyCard({
  machine,
  startRef,
}: {
  machine: BatchMachine;
  startRef: React.Ref<HTMLButtonElement>;
}) {
  const { stats } = machine;
  return (
    <Card
      className={cn(
        'flex shrink-0 flex-col gap-2.5 border-2 border-teal-200',
        CARD_GAP_COMPACT,
        CARD_PAD,
      )}
    >
      <div className="flex items-center gap-2">
        <span className="h-[9px] w-[9px] animate-recpulse rounded-sm bg-teal-600" />
        <span data-testid="phase-title" className="text-[17px] font-bold text-teal-700">
          READY
        </span>
        <div className="flex-1" />
        <span className="font-mono text-xs text-gray-500">
          Ep {stats.epNext} / {machine.targetEpisodes}
        </span>
      </div>
      {/* Real next-start summary (was a fabricated "12/12 topics live"). */}
      <span className="text-xs text-gray-500">
        Next recording captures{' '}
        {machine.selection.customized
          ? `${machine.selection.count} selected topic${machine.selection.count === 1 ? '' : 's'}`
          : machine.selection.topics === 'all'
            ? 'all topics'
            : `${machine.selection.count} configured topics`}
        {/* Server-reported pre-armed (two-phase start): the recorder is
            spawned + subscribed, so this Start is a near-instant resume.
            Shown only when the recorder actually says so. */}
        {machine.preArmed && (
          <span
            data-testid="prearmed-note"
            className="ml-1.5 inline-flex items-center gap-1 font-medium text-teal-700"
          >
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-teal-500" />
            pre-armed · instant start
          </span>
        )}
      </span>
      {/* Pre-arm failing (S2-7): Start still works via the full synchronous
          path, but the blocker (topic mismatch, disk full) is the operator's
          to fix — silence here used to bury it. */}
      {!machine.preArmed && machine.preArmDegraded && (
        <span
          data-testid="prearm-degraded-note"
          className="text-xs font-medium text-amber-700"
        >
          Pre-arm is failing — Start will do a full (slower) start.{' '}
          {machine.preArmDegraded}
        </span>
      )}
      <button
        ref={startRef}
        type="button"
        data-testid="start-recording"
        onClick={machine.startRecording}
        disabled={machine.noSelection || machine.operatorMissing}
        className={cn(
          'flex h-[52px] items-center justify-center gap-2 rounded-control text-[15px] font-bold shadow-btn [@media(max-height:860px)]:h-[44px]',
          machine.noSelection || machine.operatorMissing
            ? 'cursor-not-allowed bg-gray-200 text-gray-400'
            : 'bg-teal-600 text-white hover:bg-teal-700',
        )}
      >
        <span className="h-2.5 w-2.5 rounded-full bg-white" />
        Start recording
        <span className="text-[11px] font-medium opacity-70">· R</span>
      </button>
      {machine.noSelection && (
        <span className="text-[11px] font-medium text-amber-600">
          Every topic is cleared — select at least one in Monitor to record.
        </span>
      )}
      {machine.operatorMissing && (
        <span data-testid="operator-gate-note" className="text-[11px] font-medium text-amber-600">
          Pick your name first (OP chip, top right) — recordings must say who
          made them.
        </span>
      )}
      {machine.startError && (
        <MachineErrorBanner label="Start failed" error={machine.startError} />
      )}
    </Card>
  );
}
