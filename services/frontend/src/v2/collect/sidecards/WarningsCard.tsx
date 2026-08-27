// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Active warnings: the live signals that mean this take is being recorded worse
// than the operator thinks. Never a fabricated one.
//
// Two of them are alerts in their own right (uncaptured targets, firing monitor
// alerts). The third is not: it is the System status card's own rows, restated
// here whenever one of them is CHECK. That card sits directly above this one,
// and this one used to answer from its own sources alone — so "✓ No active
// warnings" could be rendered under two CHECK rows, and a non-expert operator
// had nothing on screen telling them which line to believe (#13).

import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { queryKeys } from '../../../api/queryKeys';
import { Card, cn } from '../../../components/ui';
import type { AlertEvent } from '../../../api/types';
import type { RuntimeConfig } from '../../../config';
import type { BatchMachine } from '../useBatchMachine';
import { SIDE_PAD } from '../compact';
import { useMonitorRows } from '../../../features/monitor/useMonitorRows';
import {
  armingWarning,
  configMismatchHint,
  firingAlertRows,
  topicRateIssues,
} from '../warnings';
import { Chip } from './Chip';
import { needsAttentionItems } from './needsAttention';
import { useSharedSystemRows } from './systemRowsStore';

// How many firing-alert lines the card shows before folding into "+N more".
const ALERTS_SHOWN = 2;

export function WarningsCard({
  machine,
  defaultTopics,
  config,
}: {
  machine: BatchMachine;
  defaultTopics: string[];
  config: RuntimeConfig;
}) {
  const { t } = useTranslation('collect');
  // Two REAL live signals, never a fabricated one (honesty rule):
  //  - target topics the recorder is not capturing (arming snapshot, OL-①.4 —
  //    re-read live while armed, then frozen at resume as start-time coverage),
  //    reported by CAUSE so a topic that is publishing is never called dead, and
  //  - FIRING monitor alerts (threshold breaches over SSE) restricted to the
  //    recorded topics — the mid-recording degradation the snapshot can't see
  //    ("camera dropped to 12 Hz"), surfaced where the operator is looking.
  const uncaptured = armingWarning(machine.arming);
  // The same monitor data Overview already reads. `rows` is every topic on the
  // graph; the mismatch question is whether it dwarfs the configured set that
  // is sitting silent.
  const { rows } = useMonitorRows(config);
  const rateIssues = topicRateIssues(rows);
  const mismatch = configMismatchHint(uncaptured?.topics.length ?? 0, rows.length);
  const shown = uncaptured?.topics.slice(0, 3) ?? [];

  // Read-only view of the SSE-populated alert buffer (useEventStream writes it).
  const { data: alertBuffer } = useQuery<AlertEvent[]>({
    queryKey: queryKeys.alerts,
    queryFn: () => {
      throw new Error('SSE-only cache: written by useEventStream');
    },
    enabled: false,
  });
  const firing = firingAlertRows(alertBuffer ?? [], machine.arming, defaultTopics);
  const firingShown = firing.slice(0, ALERTS_SHOWN);

  const count = (uncaptured?.topics.length ?? 0) + firing.length;
  const hasWarnings = count > 0;

  // The System status rows exactly as that card derived them (systemRowsStore),
  // filtered to the ones showing CHECK. Not re-derived here: the chip logic
  // lives in useSystemRows and stays there, so the two cards cannot drift into
  // disagreeing about the same fact.
  const systemRows = useSharedSystemRows();
  const checks = needsAttentionItems(systemRows, {
    uncapturedShown: uncaptured != null,
  });
  // The summary chip never outranks its own contents: amber only if one of the
  // rows is itself amber (a CHECK on a row whose tone stayed gray — an SSE pipe
  // that has not opened yet — is a "we cannot say", not a fault).
  const checksTone = checks.some((c) => c.tone === 'amber') ? 'amber' : 'gray';

  return (
    <Card
      className={cn(
        'flex shrink-0 flex-col gap-2 [@media(max-height:860px)]:gap-1',
        SIDE_PAD,
      )}
    >
      {/* flex-wrap: with both counts up the two chips can exceed the 340px
          column, and a count pushed off the edge is the same silence this card
          is being fixed for. */}
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-muted">
          {t('activeWarnings')}
        </h2>
        <div className="flex-1" />
        {/* The bare "0" is reachable ONLY when there is nothing to report at
            all — neither a warning nor an open check. It is what the all-clear
            looks like, and it may not be shown beside a CHECK. */}
        {hasWarnings ? (
          <Chip tone={firing.length > 0 ? 'red' : 'amber'}>
            {t('needsAttentionCount', { count })}
          </Chip>
        ) : checks.length === 0 ? (
          <Chip tone="gray">0</Chip>
        ) : null}
        {checks.length > 0 && (
          <Chip tone={checksTone}>{t('toCheckCount', { count: checks.length })}</Chip>
        )}
      </div>
      {uncaptured && (
        <div
          data-testid="collect-uncaptured-topics"
          className="flex flex-col gap-0.5 rounded-control border border-status-warning-border bg-status-warning-bg px-3 py-2.5"
        >
          <div className="flex items-center gap-2">
            <span className="h-[7px] w-[7px] shrink-0 rounded-sm bg-status-warning-accent" />
            <span className="text-[13px] font-semibold text-status-warning-text">
              {uncaptured.title}
            </span>
          </div>
          <span className="pl-[15px] text-xs text-status-warning-text">
            {uncaptured.detail}
          </span>
          <span
            className="truncate pl-[15px] font-mono text-[11px] text-status-warning-text"
            title={uncaptured.topics.join('\n')}
          >
            {shown.join(', ')}
            {uncaptured.topics.length > shown.length ? ' …' : ''}
          </span>
          {mismatch && (
            <span
              data-testid="collect-config-mismatch"
              className="pl-[15px] pt-1 text-xs font-medium text-status-warning-text"
            >
              {t('configMismatchWarning', {
                silent: String(mismatch.configuredSilent),
                discovered: String(mismatch.discovered),
              })}
            </span>
          )}
        </div>
      )}
      {firing.length > 0 && (
        <div
          data-testid="collect-firing-alerts"
          className="flex flex-col gap-1 rounded-control border border-status-danger-border bg-status-danger-bg px-3 py-2.5"
        >
          {firingShown.map((a) => (
            <div key={a.key} className="flex flex-col gap-0.5">
              <div className="flex items-center gap-2">
                <span className="h-[7px] w-[7px] shrink-0 rounded-sm bg-status-danger-accent" />
                <span
                  className="truncate text-[13px] font-semibold text-status-danger-text"
                  title={a.topic}
                >
                  {a.title}
                </span>
              </div>
              <span className="pl-[15px] font-mono text-[11px] text-status-danger-text">
                {a.detail}
                {a.detail ? ' · ' : ''}
                {t('sinceTime', { time: a.time })}
              </span>
            </div>
          ))}
          {firing.length > firingShown.length && (
            <span className="pl-[15px] text-[11px] text-status-danger-text">
              {t('moreInMonitor', { count: firing.length - firingShown.length })}
            </span>
          )}
        </div>
      )}
      {/* Deliberately NOT styled as an alert: no fill, no coloured dot, its own
          heading. These are the System status card's own checks — the chip and
          tone are that row's, unchanged — and dressing them as firing alerts
          would invent a severity nobody measured. They still cannot be missed,
          which is the whole point. */}
      {checks.length > 0 && (
        <div
          data-testid="collect-needs-attention"
          className="flex flex-col gap-1.5 rounded-control border border-border bg-surface-muted px-3 py-2.5"
        >
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-muted">
            {t('systemChecks', { count: checks.length })}
          </h3>
          {checks.map((item) => (
            <div
              key={item.id ?? item.label}
              data-testid={`collect-check-${item.id ?? item.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
              className="flex flex-col gap-0.5"
            >
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-[13px] font-semibold text-text-primary">
                  {item.label}
                </span>
                {item.id === 'topic-rates' &&
                (item.cause === 'rates-shortfall' || item.cause === 'rates-mixed') &&
                rateIssues.length > 0 ? (
                  <span className="font-mono text-[11px] text-text-muted">
                    {t('rateTopicsNeedAttention', { count: rateIssues.length })}
                  </span>
                ) : (
                  <span
                    className="truncate font-mono text-[11px] text-text-muted"
                    title={item.value}
                  >
                    {item.value}
                  </span>
                )}
                <div className="flex-1" />
                <Chip tone={item.tone}>{item.chip}</Chip>
              </div>
              {item.id === 'topic-rates' &&
                (item.cause === 'rates-shortfall' || item.cause === 'rates-mixed') &&
                rateIssues.length > 0 && (
                  <div
                    data-testid="collect-rate-topics"
                    className="my-1 divide-y divide-border rounded-control border border-border bg-surface"
                  >
                    {rateIssues.map((issue) => (
                      <div
                        key={issue.name}
                        data-testid="collect-rate-topic"
                        className="flex flex-col gap-0.5 px-2.5 py-2"
                      >
                        <span className="break-all font-mono text-[11px] font-semibold text-text-primary">
                          {issue.name}
                        </span>
                        <span className="font-mono text-[11px] text-text-muted">
                          {t('currentExpectedRates', {
                            current: formatRateHz(issue.currentHz),
                            expected: `${issue.learnedReference ? '~' : ''}${formatRateHz(issue.expectedHz)}`,
                          })}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              <span className="text-xs text-text-secondary">{item.impact}</span>
              <span className="text-xs font-medium text-text-primary">
                {item.action}
              </span>
            </div>
          ))}
        </div>
      )}
      {hasWarnings || checks.length > 0 ? (
        <button
          type="button"
          onClick={machine.goMonitor}
          className="rounded-control border border-border bg-surface py-2 text-[12.5px] font-semibold text-accent hover:bg-interaction-selected"
        >
          {t('openMonitor')}
        </button>
      ) : (
        // The all-clear. It speaks for the checks too now, so it may only
        // appear when both are empty — that pairing IS the bug in #13.
        checks.length === 0 && (
          <div className="flex items-center gap-2 py-1">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-status-success-bg text-xs font-bold text-status-success-text">
              ✓
            </span>
            <span className="text-[12.5px] text-text-muted">
              {t('noActiveWarnings')}
            </span>
          </div>
        )
      )}
    </Card>
  );
}

function formatRateHz(value: number | null): string {
  return value == null || !Number.isFinite(value) ? '—' : `${value.toFixed(1)} Hz`;
}
