// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// ENDED: the set stopped short of its target. The summary leads with what was
// kept, because the operator's first question after an early end is whether
// the episodes already recorded survived it.

import { Card, cn } from '../../../components/ui';
import { useTranslation } from 'react-i18next';
import { CARD_PAD } from '../compact';
import type { BatchMachine } from '../useBatchMachine';
import { CARD_GAP_COMPACT, formatEndSummary } from './shared';

export function EndedCard({
  machine,
  confirmNextSet,
  onStartNextSet,
}: {
  machine: BatchMachine;
  confirmNextSet: boolean;
  onStartNextSet: () => void;
}) {
  const { t } = useTranslation('collect');
  const endSummary = formatEndSummary(machine.stats);
  return (
    <Card
      className={cn(
        'flex shrink-0 flex-col gap-2.5 border-2 border-status-warning-border',
        CARD_GAP_COMPACT,
        CARD_PAD,
      )}
    >
      <div className="flex items-center gap-2">
        <h2 className="text-[15px] font-bold text-text-primary">
          {t('endedCardTitle', { batch: String(machine.batchSeq ?? '—') })}
        </h2>
        <div className="flex-1" />
        <span className="rounded-chip bg-status-warning-bg px-2 py-0.5 text-[11px] font-bold text-status-warning-text">
          {t('incomplete')}
        </span>
      </div>
      <span className="text-[12.5px] leading-relaxed text-text-muted">
        {endSummary}. {t('endedCardSummary')}
      </span>
      <span className="text-xs text-text-muted">
        {t('endReason', { reason: machine.endReason })}
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
        {confirmNextSet ? t('pressAgainStartNextSet') : t('startNextSet')}
      </button>
      {confirmNextSet && (
        <span data-testid="next-set-note" className="text-[11.5px] text-text-muted">
          {t('nextSetPanelHelp')}
        </span>
      )}
    </Card>
  );
}
