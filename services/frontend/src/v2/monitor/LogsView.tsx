// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Monitor > Logs — a session event timeline (§11). A chronological feed of the
// real SSE lifecycle events received since this page opened (record_status /
// alert / job), read from the bounded ring buffer useEventStream keeps in the
// query cache (queryKeys.eventLog). Type-chip + text filters narrow it. This is
// honestly labelled session-local, NOT a server log: the full service logs live
// in `docker compose logs`. Nothing is fabricated — an empty buffer says so.

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../../api/queryKeys';
import type { SessionLogEntry, SessionLogType } from '../../api/types';
import { Card, cn, type Tone } from '../../components/ui';
import { formatTime } from '../../i18n/format';
import { useTranslation } from 'react-i18next';

type TypeFilter = 'all' | SessionLogType;
const TYPE_FILTERS: TypeFilter[] = ['all', 'record_status', 'alert', 'job'];
const TYPE_TONE: Record<SessionLogType, Tone> = {
  record_status: 'teal',
  alert: 'red',
  job: 'info',
};

function formatClock(ts: number): string {
  return formatTime(new Date(ts));
}

export function LogsView() {
  const { t } = useTranslation('monitor');
  const typeLabel: Record<TypeFilter, string> = {
    all: t('logs.all'),
    record_status: t('logs.recording'),
    alert: t('logs.alerts'),
    job: t('logs.jobs'),
  };
  const { data } = useQuery<SessionLogEntry[]>({
    queryKey: queryKeys.eventLog,
    queryFn: () => {
      throw new Error('SSE-only cache: written by useEventStream');
    },
    enabled: false,
  });
  const entries = data ?? [];

  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      if (typeFilter !== 'all' && e.type !== typeFilter) return false;
      if (q && !e.summary.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [entries, typeFilter, query]);

  return (
    <Card className="flex flex-1 flex-col lg:min-h-0" data-testid="monitor-logs">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-border px-4 py-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-muted">
          {t('logs.title')}
        </h2>
        <span
          data-testid="logs-count"
          className="font-mono text-[11.5px] text-text-muted"
        >
          {t('logs.count', { count: entries.length })}
        </span>
        <div className="flex-1" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('logs.filter')}
          aria-label={t('logs.filterLabel')}
          data-testid="logs-filter"
          className="w-40 rounded-control border border-border px-2.5 py-1 text-[12px] focus:border-accent focus:outline-none"
        />
        <div className="flex gap-[3px] rounded-control border border-border bg-surface-muted p-1">
          {TYPE_FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              data-testid={`logs-type-${f}`}
              aria-pressed={f === typeFilter}
              onClick={() => setTypeFilter(f)}
              className={cn(
                'rounded-chip px-2.5 py-0.5 text-[11px] font-medium transition-colors',
                f === typeFilter
                  ? 'bg-surface text-accent shadow-sm'
                  : 'text-text-secondary hover:text-text-primary',
              )}
            >
              {typeLabel[f]}
            </button>
          ))}
        </div>
      </div>

      <p className="border-b border-border px-4 py-2 text-[11px] leading-relaxed text-text-muted">
        {t('logs.note')}
      </p>

      <div className="flex flex-col overflow-auto p-2.5">
        {entries.length === 0 ? (
          <p
            data-testid="logs-empty"
            className="px-1.5 py-8 text-center text-[12px] text-text-muted"
          >
            {t('logs.empty')}
          </p>
        ) : filtered.length === 0 ? (
          <p
            data-testid="logs-no-match"
            className="px-1.5 py-8 text-center text-[12px] text-text-muted"
          >
            {t('logs.noMatch')}
          </p>
        ) : (
          filtered.map((e) => (
            <div
              key={e.id}
              data-testid="logs-row"
              className="flex items-baseline gap-2.5 rounded-control px-2 py-1.5 hover:bg-surface-muted"
            >
              <span className="shrink-0 font-mono text-[11px] tabular-nums text-text-muted">
                {formatClock(e.ts)}
              </span>
              <span
                className={cn(
                  'shrink-0 rounded-chip px-1.5 py-0.5 text-[10px] font-semibold',
                  TYPE_TONE[e.type] === 'red'
                    ? 'bg-status-danger-bg text-status-danger-text'
                    : TYPE_TONE[e.type] === 'info'
                      ? 'bg-status-info-bg text-status-info-text'
                      : 'bg-interaction-selected text-accent',
                )}
              >
                {typeLabel[e.type]}
              </span>
              <span
                className="min-w-0 flex-1 truncate font-mono text-[12px] text-text-primary"
                title={e.summary}
              >
                {e.summary}
              </span>
            </div>
          ))
        )}
      </div>
    </Card>
  );
}
