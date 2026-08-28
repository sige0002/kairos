// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Monitor context strip chip: the REAL current recording state (REC + run_id +
// capture id + elapsed while a capture is running, STANDBY otherwise), from
// /record/status — no invented episode number or time range. Shares the
// record-status query cache with Collect / the header (react-query dedupes by
// key); SSE record_status events keep it fresh between polls.

import { Card } from '../../components/ui';
import { useRecordStatus } from '../captures/useRecordStatus';
import { useNowClock } from './useNowClock';
import { computeRecordContext, formatElapsed } from './recordContext';
import { useTranslation } from 'react-i18next';

/** Why an unconfirmed live set may not be shown as "nothing is running": the
 *  recorder either answered without its live-capture list (§10 rev.2.4) or did
 *  not answer at all, and neither is evidence that nothing is recording. */
export function RecordContextChip() {
  const { t } = useTranslation('monitor');
  const view = useRecordStatus();
  const isPending = view.loading;
  // The clock only runs while a recording is genuinely in progress — a stale
  // payload from a dead recorder must not keep an elapsed timer ticking.
  const now = useNowClock(view.recording);
  const ctx = computeRecordContext(view, now);

  return (
    <Card
      className="flex items-center gap-2.5 px-3.5 py-2"
      data-testid="monitor-context"
    >
      <h2 className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-text-muted">
        {t('context.title')}
      </h2>
      {ctx.recording ? (
        <>
          <span
            data-testid="context-state"
            className="inline-flex items-center gap-1.5 rounded-chip bg-status-danger-bg px-[7px] py-0.5 text-[10.5px] font-bold text-status-danger-text"
          >
            <span className="h-[7px] w-[7px] animate-pulse rounded-full bg-status-danger-accent" />
            REC
          </span>
          <span className="font-mono text-[12.5px] font-semibold text-text-primary">
            {ctx.runId ?? '—'}
          </span>
          {/* The identity, abbreviated to fit the strip; the full id is the
              title so it can be read and copied without leaving Monitor. */}
          <span
            data-testid="context-capture"
            data-capture-id={ctx.captureId ?? ''}
            title={ctx.captureId ?? t('context.unnamedCapture')}
            className="font-mono text-[11px] text-text-muted"
          >
            {ctx.captureId ? ctx.captureId.slice(0, 8) : '—'}
          </span>
          <span className="font-mono text-xs text-text-muted">
            {formatElapsed(ctx.elapsedMs)}
          </span>
        </>
      ) : isPending ? (
        <span
          data-testid="context-state"
          className="inline-flex rounded-chip bg-surface-muted px-[7px] py-0.5 text-[10.5px] font-bold text-text-secondary"
        >
          {t('record.checking')}
        </span>
      ) : ctx.liveKnown ? (
        <span
          data-testid="context-state"
          className="inline-flex rounded-chip bg-surface-muted px-[7px] py-0.5 text-[10.5px] font-bold text-text-secondary"
        >
          {t('record.standby')}
        </span>
      ) : (
        <span
          data-testid="context-state"
          title={t('context.liveStateUnreportedTitle')}
          className="inline-flex rounded-chip bg-status-warning-bg px-[7px] py-0.5 text-[10.5px] font-bold text-status-warning-text"
        >
          {t('record.liveStateUnreported')}
        </span>
      )}
    </Card>
  );
}
