// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// The external-operator HUD (#37): a compact, always-visible surface showing
// what LEFT / CENTER / RIGHT DO RIGHT NOW. It renders the machine's own
// `externalActionMeanings` — the SAME value the shortcut handler dispatches
// on (machine/externalActions.ts) — so the display cannot drift from the
// behavior, and it needs no second interpretation.
//
// HCD notes: the meaning is text, never color alone; a disabled slot reads
// "—" (does nothing here, which is the truth); an unassigned failure slot
// reads "Unassigned" so the operator knows the press will only explain
// itself, not save; and in Failure mode the current TASK is named, because
// the reasons shown are that task's, and a task switch re-renders them.

import { cn } from '../../components/ui';
import { Card } from '../../components/ui';
import { CARD_PAD } from './compact';
import {
  EXTERNAL_ACTION_KEYS,
  EXTERNAL_ACTION_SLOTS,
  externalActionMeaningLabel,
  type ExternalActionMeanings,
  type ExternalSlotMeaning,
} from './machine/externalActions';

function SlotMeaning({
  meaning,
  slot,
}: {
  meaning: ExternalSlotMeaning;
  slot: (typeof EXTERNAL_ACTION_SLOTS)[number];
}) {
  const emphasized = meaning.kind !== 'disabled';
  return (
    <div
      className="flex min-w-0 flex-col items-center gap-1 text-center"
      data-testid={`ext-action-${slot}`}
    >
      <span className="text-[10.5px] font-bold uppercase tracking-[0.08em] text-text-muted">
        {slot}
      </span>
      <span
        data-testid={`ext-action-${slot}-meaning`}
        title={EXTERNAL_ACTION_KEYS[slot]}
        className={cn(
          'truncate text-[12px] font-bold uppercase tracking-wide',
          meaning.kind === 'unassigned'
            ? 'normal-case text-status-warning-text'
            : emphasized
              ? 'text-text-primary'
              : 'font-normal text-text-muted',
        )}
      >
        {externalActionMeaningLabel(meaning)}
      </span>
    </div>
  );
}

export function ExternalActionHud({
  meanings,
  taskName,
}: {
  meanings: ExternalActionMeanings;
  taskName: string | null;
}) {
  const inFailureReasonMode = EXTERNAL_ACTION_SLOTS.some(
    (slot) =>
      meanings[slot].kind === 'save-failure-reason' ||
      meanings[slot].kind === 'unassigned',
  );
  return (
    <Card
      className={cn('shrink-0 border-border', CARD_PAD)}
      data-testid="ext-action-hud"
    >
      <div className="flex items-baseline gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-muted">
          {inFailureReasonMode ? 'Failure reason' : 'External controls'}
        </h3>
        {inFailureReasonMode && taskName && (
          <span
            className="truncate text-[11.5px] font-semibold text-text-primary"
            data-testid="ext-action-task-name"
          >
            {taskName}
          </span>
        )}
        <div className="flex-1" />
        <span className="hidden text-[10.5px] text-text-muted [@media(min-width:1280px)]:block">
          Ctrl+Alt+1/2/3
        </span>
      </div>
      <div className="mt-1.5 grid grid-cols-3 gap-1.5" role="status">
        {EXTERNAL_ACTION_SLOTS.map((slot) => (
          <SlotMeaning key={slot} meaning={meanings[slot]} slot={slot} />
        ))}
      </div>
    </Card>
  );
}
