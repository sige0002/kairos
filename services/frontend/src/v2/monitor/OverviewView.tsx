// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Monitor > Overview — the diagnostic landing (§11). A single glance answers
// "is capture running, is anything unhealthy, and where do I look next":
//   - record context (REC + run + elapsed, or STANDBY) from /record/status,
//   - a topic-health tally (ok / warning / danger / inactive) from the live
//     metrics, with the topics that need attention listed by name and clickable
//     straight to the Topics chart,
//   - active incidents folded from the real alert buffer,
//   - a compact system snapshot (reused SystemCard), and
//   - jump links into Topics / Signals.
// Every number is measured; each empty state explains itself (no fabrication).

import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../../api/queryKeys';
import type { AlertEvent, TopicStatus } from '../../api/types';
import type { RuntimeConfig } from '../../config';
import { Card, StatusDot } from '../../components/ui';
import { statusTone, useMonitorRows } from '../../features/monitor/useMonitorRows';
import { SystemCard } from './SystemCard';
import { useRecordStatus } from '../captures/useRecordStatus';
import { useNowClock } from './useNowClock';
import { computeRecordContext, formatElapsed } from './recordContext';
import { toAlertRows } from './alerts';
import { useTranslation } from 'react-i18next';

/** Statuses that warrant operator attention, worst-first. */
const ATTENTION: TopicStatus[] = ['danger', 'inactive'];

function RecordContextBlock() {
  const { t } = useTranslation('monitor');
  const view = useRecordStatus();
  const isPending = view.loading;
  const now = useNowClock(view.recording);
  const ctx = computeRecordContext(view, now);

  return (
    <Card className="flex flex-col gap-2 px-4 py-3.5" data-testid="overview-record">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-secondary">
        {t('record.title')}
      </h2>
      {ctx.recording ? (
        <>
          <div className="flex flex-wrap items-center gap-2.5">
            <span
              data-testid="overview-record-state"
              className="inline-flex items-center gap-1.5 rounded-chip bg-status-danger-bg px-[7px] py-0.5 text-[10.5px] font-bold text-status-danger-text"
            >
              <span className="h-[7px] w-[7px] animate-recpulse rounded-full bg-status-danger-accent" />
              REC
            </span>
            <span className="font-mono text-[13px] font-semibold text-text-primary">
              {ctx.runId ?? '—'}
            </span>
            <span className="font-mono text-xs text-text-secondary">
              {formatElapsed(ctx.elapsedMs)}
            </span>
          </div>
          {/* The run name above is display text (§1); this is the identity the
              capture list, jobs and reports are keyed by. */}
          <span
            data-testid="overview-record-capture"
            className="font-mono text-[11px] text-text-secondary"
          >
            {t('record.capture', {
              captureId: ctx.captureId ?? `— (${t('record.unnamedCapture')})`,
            })}
          </span>
        </>
      ) : isPending ? (
        <span
          data-testid="overview-record-state"
          className="inline-flex w-fit rounded-chip bg-surface-muted px-[7px] py-0.5 text-[10.5px] font-bold text-text-secondary"
        >
          {t('record.checking')}
        </span>
      ) : ctx.liveKnown ? (
        <span
          data-testid="overview-record-state"
          className="inline-flex w-fit rounded-chip bg-surface-muted px-[7px] py-0.5 text-[10.5px] font-bold text-text-secondary"
        >
          {t('record.standby')}
        </span>
      ) : (
        <>
          <span
            data-testid="overview-record-state"
            className="inline-flex w-fit rounded-chip bg-status-warning-bg px-[7px] py-0.5 text-[10.5px] font-bold text-status-warning-text"
          >
            {t('record.liveStateUnreported')}
          </span>
          <span className="text-[11.5px] leading-relaxed text-text-secondary">
            {t('record.liveStateUnreportedHelp')}
          </span>
        </>
      )}
    </Card>
  );
}

export function OverviewView({
  config,
  onOpenTopics,
  onOpenSignals,
}: {
  config: RuntimeConfig;
  onOpenTopics: (topic?: string) => void;
  onOpenSignals: () => void;
}) {
  const { t } = useTranslation('monitor');
  const { rows, isDiscovering } = useMonitorRows(config);

  // SSE-fed alert buffer → incidents (grouped by topic+metric).
  const { data: alerts } = useQuery<AlertEvent[]>({
    queryKey: queryKeys.alerts,
    queryFn: () => {
      throw new Error('SSE-only cache: written by useEventStream');
    },
    enabled: false,
  });
  // Reuse the shared incident collapse (one row per topic+metric, newest wins,
  // firing sorted first) rather than a second model.
  const firing = toAlertRows(alerts ?? [], 100).filter((i) => i.state === 'firing');

  const measured = rows.filter((r) => r.measured);
  const tally = [
    { status: 'ok', label: t('topics.ok') },
    { status: 'warning', label: t('topics.warning') },
    { status: 'danger', label: t('topics.danger') },
    { status: 'inactive', label: t('topics.inactive') },
  ] as const;
  const counts = tally.map((item) => ({
    ...item,
    n: measured.filter((r) => r.status === item.status).length,
  }));
  const attention = measured.filter((r) => r.status && ATTENTION.includes(r.status));

  return (
    <div
      className="grid flex-1 grid-cols-1 gap-2.5 overflow-auto lg:min-h-0 lg:grid-cols-[1fr_340px]"
      data-testid="monitor-overview"
    >
      <div className="flex flex-col gap-2.5">
        <RecordContextBlock />

        {/* Topic health tally + the topics that need attention */}
        <Card className="flex flex-col" data-testid="overview-health">
          <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-secondary">
              {t('overview.topicHealth')}
            </h2>
            <div className="flex-1" />
            <span className="font-mono text-[11.5px] text-text-secondary">
              {t('overview.topicCount', {
                measured: String(measured.length),
                discovered: String(rows.length),
              })}
            </span>
          </div>

          {rows.length === 0 ? (
            <p
              data-testid="overview-health-empty"
              className="px-4 py-8 text-center text-[12.5px] text-text-secondary"
            >
              {isDiscovering ? t('overview.discovering') : t('overview.noTopics')}
            </p>
          ) : measured.length === 0 ? (
            <p
              data-testid="overview-health-nometrics"
              className="px-4 py-8 text-center text-[12.5px] leading-relaxed text-text-secondary"
            >
              {t('overview.noMetrics')}
            </p>
          ) : (
            <div className="flex flex-col gap-3 p-4">
              <div className="grid grid-cols-4 gap-2" data-testid="overview-tally">
                {counts.map((c) => (
                  <div
                    key={c.status}
                    data-testid={`tally-${c.status}`}
                    className="flex flex-col items-center gap-1 rounded-control border border-border bg-surface-muted py-2.5"
                  >
                    <span className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.04em] text-text-secondary">
                      <StatusDot tone={statusTone(c.status)} />
                      {c.label}
                    </span>
                    <span className="font-mono text-[17px] font-bold text-text-primary">
                      {c.n}
                    </span>
                  </div>
                ))}
              </div>

              {attention.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                  <h3 className="text-[11px] font-semibold uppercase tracking-[0.04em] text-text-secondary">
                    {t('overview.needsAttention')}
                  </h3>
                  <div className="flex flex-col gap-1" data-testid="overview-attention">
                    {attention.map((r) => (
                      <button
                        key={r.name}
                        type="button"
                        data-testid={`attention-${r.name}`}
                        onClick={() => onOpenTopics(r.name)}
                        className="flex items-center gap-2 rounded-control border border-border px-2.5 py-2 text-left hover:bg-surface-muted"
                      >
                        <StatusDot tone={statusTone(r.status)} />
                        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-text-primary">
                          {r.name}
                        </span>
                        <span className="text-[11px] font-semibold text-text-secondary">
                          {t(`topics.${r.status}` as 'topics.warning')}
                        </span>
                        <span className="text-[11px] text-accent">
                          {t('overview.chart')}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <p
                  data-testid="overview-attention-none"
                  className="text-[12px] text-text-secondary"
                >
                  {t('overview.allHealthy')}
                </p>
              )}
            </div>
          )}
        </Card>

        {/* Active incidents (real alert buffer) */}
        <Card className="flex flex-col" data-testid="overview-incidents">
          <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-secondary">
              {t('overview.activeIncidents')}
            </h2>
            <div className="flex-1" />
            <span className="font-mono text-[11.5px] text-text-secondary">
              {t('overview.firingCount', { count: firing.length })}
            </span>
          </div>
          {firing.length === 0 ? (
            <p
              data-testid="overview-incidents-empty"
              className="px-4 py-6 text-center text-[12px] text-text-secondary"
            >
              {t('overview.noFiring')}
            </p>
          ) : (
            <div className="flex flex-col gap-0.5 p-2.5">
              {firing.slice(0, 4).map((i) => (
                <div
                  key={i.key}
                  data-testid="overview-incident-row"
                  className="flex items-start gap-2.5 rounded-control bg-status-danger-bg px-2.5 py-2"
                >
                  <StatusDot tone="red" className="mt-[5px]" />
                  <div className="flex min-w-0 flex-col">
                    <span className="text-[12.5px] font-semibold text-text-primary">
                      {i.title}
                      {i.detail && (
                        <span className="font-normal text-text-secondary">
                          {' '}
                          · {i.detail}
                        </span>
                      )}
                    </span>
                    <span className="font-mono text-[11px] text-text-secondary">
                      {t('events.firingSince', { time: i.time })}
                    </span>
                  </div>
                </div>
              ))}
              {firing.length > 4 && (
                <button
                  type="button"
                  onClick={() => onOpenTopics()}
                  className="px-2.5 py-1.5 text-left text-[11.5px] font-semibold text-accent hover:underline"
                >
                  {t('overview.moreIncidents', { count: firing.length - 4 })}
                </button>
              )}
            </div>
          )}
        </Card>
      </div>

      <div className="flex flex-col gap-2.5">
        <SystemCard />
        <Card className="flex flex-col gap-2 p-4">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-secondary">
            {t('overview.jumpTo')}
          </h2>
          <button
            type="button"
            data-testid="overview-open-topics"
            onClick={() => onOpenTopics()}
            className="rounded-control border border-border bg-surface px-3 py-2 text-left text-[12.5px] font-semibold text-accent hover:bg-interaction-selected"
          >
            {t('overview.openTopics')}
          </button>
          <button
            type="button"
            data-testid="overview-open-signals"
            onClick={onOpenSignals}
            className="rounded-control border border-border bg-surface px-3 py-2 text-left text-[12.5px] font-semibold text-accent hover:bg-interaction-selected"
          >
            {t('overview.openSignals')}
          </button>
        </Card>
      </div>
    </div>
  );
}
