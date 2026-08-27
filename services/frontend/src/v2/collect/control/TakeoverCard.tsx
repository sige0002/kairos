// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// The takeover card (D-1): a recording is running on this robot that this
// screen is not driving. It replaces the phase card entirely, so the only
// actions offered are the ones that make sense for someone else's take.

import { useEffect, useState } from 'react';
import { Card, cn } from '../../../components/ui';
import { formatBytes } from '../../review/format';
import { CARD_PAD } from '../compact';
import type { BatchMachine } from '../useBatchMachine';
import { CARD_GAP_COMPACT, formatElapsed } from './shared';
import { useTranslation } from 'react-i18next';

// One "Label : value" row in the takeover card (D-1). Values are real recorder
// data; missing ones render "—" (never fabricated).
function FieldRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-2.5">
      <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-muted">
        {label}
      </span>
      <div className="flex-1" />
      <span
        className={cn('text-[13px] text-text-primary', mono && 'font-mono text-xs')}
      >
        {value}
      </span>
    </div>
  );
}

export function TakeoverCard({
  machine,
  takeover,
  stopRef,
}: {
  machine: BatchMachine;
  takeover: NonNullable<BatchMachine['takeover']>;
  stopRef: React.Ref<HTMLButtonElement>;
}) {
  const { t } = useTranslation('collect');
  // Takeover card's own once-a-second elapsed ticker (the recording card uses
  // the machine's own timer instead). Scoped to this card's lifetime, which is
  // exactly the window in which a takeover is on screen.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const elapsedMs = takeover.startedAt
    ? Math.max(0, Date.now() - Date.parse(takeover.startedAt))
    : null;
  return (
    <Card
      className={cn(
        'flex shrink-0 flex-col gap-2.5 border-2 border-status-danger-border',
        CARD_GAP_COMPACT,
        CARD_PAD,
      )}
    >
      <div className="flex items-center gap-2">
        <span className="h-[9px] w-[9px] animate-recpulse rounded-sm bg-status-danger-accent" />
        <h2
          data-testid="phase-title"
          className="text-[15px] font-bold text-status-danger-text"
        >
          {t('recordingInProgress')}
        </h2>
      </div>
      <span className="text-[12.5px] leading-relaxed text-text-secondary">
        {machine.takeoverResumedOwn ? t('takeoverResumed') : t('takeoverOther')}
      </span>
      <div className="flex flex-col gap-1.5 rounded-control border border-border bg-surface-muted px-3 py-2.5">
        {/* The run_id is the name the operator recognises on disk; it is shown
            and never used as a key (§1). "—" until the capture loads. */}
        <FieldRow label={t('run')} value={takeover.runLabel ?? '—'} mono />
        <div className="flex items-baseline gap-2.5">
          <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-muted">
            {t('elapsed')}
          </span>
          <div className="flex-1" />
          <span
            data-testid="takeover-elapsed"
            className="font-mono text-[34px] font-semibold text-text-primary"
          >
            {elapsedMs != null ? formatElapsed(elapsedMs) : '—'}
          </span>
        </div>
        <FieldRow
          label={t('written')}
          value={takeover.bytes != null ? formatBytes(takeover.bytes) : '—'}
          mono
        />
        <FieldRow label={t('operator')} value={takeover.operator || '—'} />
        <FieldRow
          label={t('topics')}
          value={
            takeover.topicsCount != null
              ? t('topicsCount', { count: takeover.topicsCount })
              : '—'
          }
        />
      </div>
      <button
        ref={stopRef}
        type="button"
        onClick={machine.openTakeoverStopModal}
        className="flex h-[52px] items-center justify-center gap-2 rounded-control bg-status-danger-accent text-[15px] font-bold text-status-danger-contrast shadow-btn-red hover:bg-status-danger-text [@media(max-height:860px)]:h-[44px]"
      >
        <span className="h-[11px] w-[11px] rounded-sm bg-surface" />
        {t('stopRecording')}
      </button>
      <button
        type="button"
        onClick={machine.goMonitor}
        className="self-start text-[12.5px] font-semibold text-accent hover:underline"
      >
        {t('openInMonitor')}
      </button>
    </Card>
  );
}
