// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
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
  titleRef: React.Ref<HTMLHeadingElement>;
}) {
  const saving = phase === 'saving';
  return (
    <Card
      className={cn(
        'flex shrink-0 flex-col gap-2.5 border-2 border-border',
        CARD_GAP_COMPACT,
        CARD_PAD,
      )}
    >
      <div className="flex items-center gap-2">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-accent" />
        <h2
          ref={titleRef}
          data-testid="phase-title"
          tabIndex={-1}
          aria-live="polite"
          className="text-[17px] font-bold text-text-primary outline-none"
        >
          {saving ? 'SAVING…' : 'QUICK CHECK…'}
        </h2>
      </div>
      <span className="text-[12.5px] leading-relaxed text-text-muted">
        {saving
          ? machine.stopFlushSeconds != null
            ? // The wait is the recorder draining its cache — normal, measured
              // in seconds, and shown as progress rather than dressed as an
              // error (the error only appears past the full escalation budget).
              `Finalizing the recording — the recorder is flushing (${machine.stopFlushSeconds}s)…`
            : 'Finalizing the recording…'
          : 'Reading recorded counts, gaps and integrity.'}
      </span>
      {/* Indeterminate progress — the real duration isn't known, so no fake %. */}
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-muted">
        <span className="block h-full w-1/3 animate-pulse rounded-full bg-accent" />
      </div>
      {machine.stopError && (
        <>
          <MachineErrorBanner label="Stop failed" error={machine.stopError} />
          <button
            type="button"
            onClick={machine.retryStop}
            className="h-10 rounded-control bg-status-danger-accent text-[13px] font-bold text-status-danger-contrast hover:bg-status-danger-text"
          >
            Retry stop
          </button>
        </>
      )}
    </Card>
  );
}
