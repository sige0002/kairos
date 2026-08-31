// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Monitor > Events — the full-page incident view (§11). Same source as the
// right-rail EventsCard (the SSE-populated alert buffer, queryKeys.alerts) but
// folded into one row per (topic, metric) with the current value + firing/cleared
// state, and given room for filters: a topic substring box and a firing/cleared/all
// state toggle. History is session-local (accumulated since Monitor opened) and
// the header says so — no fabricated backlog.

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../../api/queryKeys';
import type { AlertEvent } from '../../api/types';
import { Card, cn, StatusDot } from '../../components/ui';
import { incidentCount, toAlertRows } from './alerts';
import { useTranslation } from 'react-i18next';

type StateFilter = 'all' | 'firing' | 'cleared';
const STATE_FILTERS: StateFilter[] = ['all', 'firing', 'cleared'];

export function EventsView() {
  const { t, i18n } = useTranslation('monitor');
  const { data } = useQuery<AlertEvent[]>({
    queryKey: queryKeys.alerts,
    queryFn: () => {
      throw new Error('SSE-only cache: written by useEventStream');
    },
    enabled: false,
  });
  // Reuse the shared incident collapse (one row per topic+metric, newest wins,
  // firing sorted first, distinct-firing-episode `refires` count).
  const incidents = useMemo(
    () => toAlertRows(data ?? [], 500),
    [data, i18n.resolvedLanguage],
  );

  const [stateFilter, setStateFilter] = useState<StateFilter>('all');
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return incidents.filter((i) => {
      if (stateFilter !== 'all' && i.state !== stateFilter) return false;
      if (q && !i.topic.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [incidents, stateFilter, query]);

  const firingCount = incidents.filter((i) => i.state === 'firing').length;
  const total = incidentCount(data ?? []);

  return (
    <Card className="flex flex-1 flex-col lg:min-h-0" data-testid="monitor-events">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-border px-4 py-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-secondary">
          {t('eventsView.title')}
        </h2>
        <span
          data-testid="events-firing-count"
          className="font-mono text-[11.5px] text-text-secondary"
        >
          {t('eventsView.count', { firing: String(firingCount), total: String(total) })}
        </span>
        <div className="flex-1" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('eventsView.filter')}
          aria-label={t('eventsView.filterLabel')}
          data-testid="events-filter"
          className="w-44 rounded-control border border-border px-2.5 py-1 text-[12px] focus:border-accent focus:outline-none"
        />
        <div className="flex gap-[3px] rounded-control border border-border bg-surface-muted p-1">
          {STATE_FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              data-testid={`events-state-${f}`}
              aria-pressed={f === stateFilter}
              onClick={() => setStateFilter(f)}
              className={cn(
                'rounded-chip px-2.5 py-0.5 text-[11px] font-medium capitalize transition-colors',
                f === stateFilter
                  ? 'bg-surface text-accent shadow-sm'
                  : 'text-text-secondary hover:text-text-primary',
              )}
            >
              {t(`eventsView.states.${f}` as 'eventsView.states.all')}
            </button>
          ))}
        </div>
      </div>

      <p className="border-b border-border px-4 py-2 text-[11px] leading-relaxed text-text-secondary">
        {t('eventsView.note')}
      </p>

      <div className="flex flex-col gap-0.5 overflow-auto p-2.5">
        {incidents.length === 0 ? (
          <p
            data-testid="events-empty"
            className="px-1.5 py-8 text-center text-[12px] text-text-secondary"
          >
            {t('events.empty')}
          </p>
        ) : filtered.length === 0 ? (
          <p
            data-testid="events-no-match"
            className="px-1.5 py-8 text-center text-[12px] text-text-secondary"
          >
            {t('eventsView.noMatch')}
          </p>
        ) : (
          filtered.map((i) => (
            <div
              key={i.key}
              data-testid="events-row"
              className={cn(
                'flex items-start gap-2.5 rounded-control px-2.5 py-2.5',
                i.state === 'firing' && 'bg-status-danger-bg',
              )}
            >
              <StatusDot tone={i.tone} className="mt-[5px]" />
              <div className="flex min-w-0 flex-1 flex-col gap-px">
                {/* Same shape as the Events rail (EventsCard), which was
                    measured painting a break-opportunity-free topic name 448px
                    outside its card. Here it is LATENT rather than reproduced:
                    this view is full-width, so the 118-char name that broke the
                    330px rail still fits. Same cause, one column wider. */}
                <span className="break-words text-[12.5px] font-semibold text-text-primary">
                  {i.title}
                  {i.detail && (
                    <span className="font-normal text-text-secondary">
                      {' '}
                      · {i.detail}
                    </span>
                  )}
                </span>
                <span className="font-mono text-[11px] text-text-secondary">
                  {i.state === 'cleared'
                    ? t('events.cleared', { time: i.time })
                    : t('events.firingSince', { time: i.time })}
                </span>
              </div>
              {i.refires > 1 && (
                <span
                  className="shrink-0 rounded-chip bg-surface-muted px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-text-secondary"
                  title={t('eventsView.refiresTitle', { count: i.refires })}
                >
                  ×{i.refires}
                </span>
              )}
            </div>
          ))
        )}
      </div>
    </Card>
  );
}
