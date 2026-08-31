// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Right-rail Events list — REAL alerts from the monitor. The `alert` SSE snapshot
// is accumulated into a rolling max-100 buffer in the TanStack Query cache by
// useEventStream (queryKeys.alerts); we READ that cache (no second SSE
// connection) and render the most recent firing/cleared breaches. Empty until an
// alert actually fires — an honest "no alerts yet" rather than a fabricated feed.

import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../../api/queryKeys';
import type { AlertEvent } from '../../api/types';
import { Card, cn } from '../../components/ui';
import { incidentCount, toAlertRows, type AlertTone } from './alerts';
import { useTranslation } from 'react-i18next';

const CAP = 12;

const DOT_COLOR: Record<AlertTone, string> = {
  red: 'bg-status-danger-accent',
  gray: 'bg-surface-muted',
};

export function EventsCard() {
  const { t } = useTranslation('monitor');
  // Read-only view of the SSE-populated alert buffer: a throwing queryFn that is
  // never enabled (same idiom as useMetricHistory's metrics cache) — the data is
  // whatever useEventStream last wrote, and this subscribes to its changes.
  const { data } = useQuery<AlertEvent[]>({
    queryKey: queryKeys.alerts,
    queryFn: () => {
      throw new Error('SSE-only cache: written by useEventStream');
    },
    enabled: false,
  });
  const alerts = data ?? [];
  const rows = toAlertRows(alerts, CAP);
  // Count distinct incidents (not raw buffer entries — a sustained breach re-sends
  // its firing state each tick), so the header is honest about how many there are.
  const total = incidentCount(alerts);

  return (
    <Card className="flex flex-1 flex-col lg:min-h-0">
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-secondary">
          {t('events.title')}
        </h2>
        <div className="flex-1" />
        <span
          data-testid="events-count"
          className="font-mono text-[11.5px] text-text-secondary"
        >
          {total > CAP ? `${CAP}/${total} ` : ''}
          {t('events.alerts', { count: total })}
        </span>
      </div>
      <div className="flex flex-col gap-0.5 overflow-auto p-2.5">
        {rows.length === 0 ? (
          <p
            data-testid="events-empty"
            className="px-1.5 py-6 text-center text-[11.5px] leading-relaxed text-text-secondary"
          >
            {t('events.empty')}
          </p>
        ) : (
          rows.map((ev) => (
            <div
              key={ev.key}
              data-testid="event-row"
              className={cn(
                'flex items-start gap-2.5 rounded-control px-2.5 py-2.5',
                ev.state === 'firing' && 'bg-status-danger-bg',
              )}
            >
              <span
                className={cn(
                  'mt-[5px] h-[7px] w-[7px] shrink-0 rounded-sm',
                  DOT_COLOR[ev.tone],
                )}
              />
              <div className="flex min-w-0 flex-col gap-px">
                {/* `min-w-0` above lets the column shrink, but a topic name with
                    no break opportunity — no slash, no space, which is what a
                    driver that underscores its whole path produces — still has
                    nowhere to wrap, so it paints straight through the card's
                    right edge (measured: 448px outside its box). `break-words`
                    breaks only a word that cannot otherwise fit, so ordinary
                    titles wrap exactly as before. */}
                <span className="break-words text-[12.5px] font-semibold text-text-primary">
                  {ev.title}
                  {ev.detail && (
                    <span className="font-normal text-text-secondary">
                      {' '}
                      · {ev.detail}
                    </span>
                  )}
                </span>
                <span className="font-mono text-[11px] text-text-secondary">
                  {ev.state === 'cleared'
                    ? t('events.cleared', { time: ev.time })
                    : t('events.firingSince', { time: ev.time })}
                  {ev.refires > 1 && (
                    <span className="text-text-secondary"> · ×{ev.refires}</span>
                  )}
                </span>
              </div>
            </div>
          ))
        )}
      </div>
    </Card>
  );
}
