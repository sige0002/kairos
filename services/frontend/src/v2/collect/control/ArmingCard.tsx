// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// ARMING: the readiness gate is open and the recorder is matching its target
// topics. Recording begins on its own once the recorder confirms, so the only
// control here is the way out.
//
// That way out is guarded for the card's first moments (#8): Cancel lands in
// nearly the hit-area Start just occupied, so the second press of a real
// double-click backed out of the take the first press had begun. While the
// guard is closed the TITLE holds focus — the same heading-with-tabIndex the
// SAVING card uses — because focus() on a disabled button is a no-op and this
// phase would otherwise be keyboard-dead, or worse, leave focus on <body> where
// the next Space press scrolls the page instead of reaching the flow.

import { Card, cn } from '../../../components/ui';
import { useTranslation } from 'react-i18next';
import { CARD_PAD } from '../compact';
import type { BatchMachine } from '../useBatchMachine';
import { ArmingNote } from './banners';
import { CARD_GAP_COMPACT } from './shared';

export function ArmingCard({
  machine,
  cancelRef,
  titleRef,
}: {
  machine: BatchMachine;
  cancelRef: React.Ref<HTMLButtonElement>;
  /** Focus target while `machine.canCancelArming` is false. ControlCard owns
   *  the hand-off from this to the Cancel button. */
  titleRef: React.Ref<HTMLHeadingElement>;
}) {
  const { t } = useTranslation(['collect', 'common']);
  const armed = machine.canCancelArming;
  return (
    <Card
      className={cn(
        'flex shrink-0 flex-col gap-2.5 border-2 border-status-warning-border',
        CARD_GAP_COMPACT,
        CARD_PAD,
      )}
    >
      <div className="flex items-center gap-2">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-status-warning-accent" />
        <h2
          ref={titleRef}
          data-testid="phase-title"
          tabIndex={-1}
          className="text-[17px] font-bold text-status-warning-text outline-none"
        >
          {t('collect:arming')}
        </h2>
      </div>
      <span className="text-[12.5px] leading-relaxed text-status-warning-text">
        {t('collect:holdStill')}
      </span>
      <button
        ref={cancelRef}
        type="button"
        data-testid="arming-cancel"
        onClick={machine.cancelArming}
        disabled={!armed}
        className={cn(
          'h-10 rounded-control border border-border bg-surface text-[13px] font-semibold text-text-muted',
          armed ? 'hover:bg-surface-muted' : 'cursor-not-allowed opacity-50',
        )}
      >
        {t('common:actions.cancel')}
      </button>
      {machine.arming && <ArmingNote arming={machine.arming} />}
    </Card>
  );
}
