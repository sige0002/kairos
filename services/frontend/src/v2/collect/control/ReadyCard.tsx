// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// READY: the pre-take card. Start is the only primary action, and it is gated
// on the two things a recording cannot be made without — at least one topic,
// and an operator who owns it.
//
// Both gates explain themselves in a note under the button, and the button
// POINTS AT the note it is blocked by (aria-describedby): a disabled control
// with an unrelated line of amber text beneath it is only self-descriptive to
// someone who can see both at once. Since #11 the operator gate fires on a
// fresh install, so this is the first thing a new operator meets.

import { Card, cn } from '../../../components/ui';
import { CARD_PAD } from '../compact';
import type { BatchMachine } from '../useBatchMachine';
import { OPERATOR_GATE_HINT } from '../machine/types';
import { MachineErrorBanner } from './banners';
import { CARD_GAP_COMPACT } from './shared';

const NO_SELECTION_NOTE_ID = 'ready-no-selection-note';
const OPERATOR_NOTE_ID = 'ready-operator-note';

export function ReadyCard({
  machine,
  startRef,
  titleRef,
}: {
  machine: BatchMachine;
  startRef: React.Ref<HTMLButtonElement>;
  /** Focus target while Start is disabled. A disabled button refuses focus(),
   *  and the phase would otherwise leave it on <body> (D-4). */
  titleRef: React.Ref<HTMLHeadingElement>;
}) {
  const { stats } = machine;
  const blocked = machine.noSelection || machine.operatorMissing;
  return (
    <Card
      className={cn(
        'flex shrink-0 flex-col gap-2.5 border-2 border-accent',
        CARD_GAP_COMPACT,
        CARD_PAD,
      )}
    >
      <div className="flex items-center gap-2">
        <span className="h-[9px] w-[9px] animate-recpulse rounded-sm bg-accent" />
        <h2
          ref={titleRef}
          data-testid="phase-title"
          tabIndex={-1}
          className="text-[17px] font-bold text-accent outline-none"
        >
          READY
        </h2>
        <div className="flex-1" />
        <span className="font-mono text-xs text-text-muted">
          Ep {stats.epNext} / {machine.targetEpisodes}
        </span>
      </div>
      {/* Real next-start summary (was a fabricated "12/12 topics live"). */}
      <span className="text-xs text-text-muted">
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
            className="ml-1.5 inline-flex items-center gap-1 font-medium text-accent"
          >
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />
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
          className="text-xs font-medium text-status-warning-text"
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
        disabled={blocked}
        // Defence in depth for #26. The popover's Enter is cancelled at source,
        // which settles the press that lifts the gate — but a HELD Enter
        // auto-repeats, and by the time the OS emits the second keydown
        // (~250-500ms) this button has both the focus and the enablement, so
        // the repeat activates it. Those repeats are not presses the operator
        // made; a recording should only ever start from one they did.
        //
        // Filtering repeats rather than adding a timed activation guard: the
        // guard would have to outlast the OS repeat delay to help at all, and a
        // Start button dead for half a second after every enablement is a worse
        // trade than this. It also costs nothing legitimate — a held key was
        // never a second deliberate press.
        onKeyDown={(e) => {
          if (e.repeat) e.preventDefault();
        }}
        // Names the note that says why, so the reason travels with the button
        // rather than sitting beside it. Both ids are listed when both gates
        // are up; a missing id is ignored by assistive tech.
        aria-describedby={
          blocked
            ? [
                machine.noSelection ? NO_SELECTION_NOTE_ID : null,
                machine.operatorMissing ? OPERATOR_NOTE_ID : null,
              ]
                .filter(Boolean)
                .join(' ')
            : undefined
        }
        className={cn(
          'flex h-[52px] items-center justify-center gap-2 rounded-control text-[15px] font-bold shadow-btn [@media(max-height:860px)]:h-[44px]',
          blocked
            ? 'cursor-not-allowed bg-surface-muted text-text-muted'
            : 'bg-accent text-text-inverse hover:bg-accent-strong',
        )}
      >
        <span className="h-2.5 w-2.5 rounded-full bg-surface" />
        Start recording
        <span className="text-[11px] font-medium opacity-70">· R</span>
      </button>
      {machine.noSelection && (
        <span
          id={NO_SELECTION_NOTE_ID}
          data-testid="no-selection-note"
          className="text-[11px] font-medium text-status-warning-text"
        >
          Every topic is cleared — select at least one in Monitor to record.
        </span>
      )}
      {machine.operatorMissing && (
        <span
          id={OPERATOR_NOTE_ID}
          data-testid="operator-gate-note"
          className="text-[11px] font-medium text-status-warning-text"
        >
          {OPERATOR_GATE_HINT}
        </span>
      )}
      {machine.startError && (
        <MachineErrorBanner label="Start failed" error={machine.startError} />
      )}
    </Card>
  );
}
