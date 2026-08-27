// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
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
        'flex shrink-0 flex-col gap-2.5 border-2 border-border',
        CARD_GAP_COMPACT,
        CARD_PAD,
      )}
    >
      <div className="flex items-center gap-2">
        <span className="h-[9px] w-[9px] rounded-sm bg-text-disabled" />
        <h2 data-testid="phase-title" className="text-[17px] font-bold text-text-muted">
          PAUSED
        </h2>
      </div>
      <span className="text-[12.5px] text-text-muted">
        Set is paused. Recorded episodes are safe.
      </span>
      <button
        type="button"
        onClick={machine.resumeBatch}
        className="h-[46px] rounded-control bg-accent text-sm font-bold text-text-inverse hover:bg-accent-strong"
      >
        Resume set
      </button>
    </Card>
  );
}
