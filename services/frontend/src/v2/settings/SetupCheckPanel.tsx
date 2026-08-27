// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki

import { useMutation } from '@tanstack/react-query';
import { runSetupCheck } from '../../api/setup';
import type {
  SetupCheckItemStatus,
  SetupCheckReport,
  SetupTopicCheck,
} from '../../api/types';
import { Badge, Button, cn } from '../../components/ui';
import { ErrorMessage } from '../../components/ErrorMessage';

function tone(status: SetupCheckItemStatus | SetupCheckReport['status']) {
  if (status === 'pass' || status === 'ready') return 'green' as const;
  if (status === 'blocker' || status === 'blocked') return 'red' as const;
  if (status === 'warning' || status === 'attention') return 'amber' as const;
  return 'gray' as const;
}

function qosLabel(topic: SetupTopicCheck, name: string): string {
  const value = topic.qos[name];
  if (!value || typeof value === 'string') return value || '—';
  const reliability = typeof value.reliability === 'string' ? value.reliability : null;
  const durability = typeof value.durability === 'string' ? value.durability : null;
  return [reliability, durability].filter(Boolean).join(' · ') || '—';
}

export function SetupCheckPanel() {
  const check = useMutation({ mutationFn: runSetupCheck });
  const report = check.data;

  return (
    <section
      data-testid="setup-check"
      className="rounded-control border border-border bg-surface-muted/60 p-3.5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-[13px] font-semibold uppercase tracking-[0.04em] text-text-secondary">
            Setup check
          </h3>
          <p className="mt-1 max-w-2xl text-[12px] leading-relaxed text-text-muted">
            Read-only. Checks recorder preconditions, configured ROS topic coverage,
            monitor intake, and camera preview. It does not start a recording or change
            config.
          </p>
        </div>
        <Button
          type="button"
          data-testid="run-setup-check"
          onClick={() => check.mutate()}
          disabled={check.isPending}
          className="shrink-0"
        >
          {check.isPending ? 'Checking…' : report ? 'Run again' : 'Run setup check'}
        </Button>
      </div>

      <div aria-live="polite" aria-atomic="false">
        {check.isError && (
          <div className="mt-3">
            <ErrorMessage error={check.error} />
          </div>
        )}

        {report && (
          <div className="mt-3 flex flex-col gap-3" data-testid="setup-check-result">
            <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-text-muted">
              <Badge tone={tone(report.status)} dot>
                {report.status}
              </Badge>
              <span>{report.robot || 'No robot'}</span>
              {report.ros_domain_id != null && (
                <span className="font-mono">ROS_DOMAIN_ID {report.ros_domain_id}</span>
              )}
              <span>{report.duration_ms.toLocaleString()} ms</span>
            </div>

            <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
              {report.checks.map((item) => (
                <li
                  key={item.id}
                  className={cn(
                    'rounded-control border bg-surface px-3 py-2',
                    item.status === 'blocker'
                      ? 'border-status-danger-border'
                      : item.status === 'warning'
                        ? 'border-status-warning-border'
                        : 'border-border',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[12.5px] font-semibold text-text-primary">
                      {item.label}
                    </span>
                    <Badge tone={tone(item.status)}>{item.status}</Badge>
                  </div>
                  <p className="mt-1 text-[11.5px] text-text-secondary">{item.summary}</p>
                  {item.action && (
                    <p className="mt-1 text-[11.5px] font-medium text-text-primary">
                      Next: {item.action}
                    </p>
                  )}
                </li>
              ))}
            </ul>

            {report.topics.length > 0 && (
              <div>
                <h4 className="mb-1.5 text-[12px] font-semibold text-text-primary">
                  Configured topic coverage
                </h4>
                <div className="max-h-72 overflow-auto rounded-control border border-border bg-surface">
                  <table className="w-full text-[11.5px]">
                    <thead className="sticky top-0 bg-surface-muted text-[10px] uppercase tracking-[0.04em] text-text-muted">
                      <tr>
                        <th className="px-2.5 py-2 text-left font-medium">Pattern</th>
                        <th className="px-2.5 py-2 text-left font-medium">Evidence</th>
                        <th className="px-2.5 py-2 text-left font-medium">
                          Resolved QoS
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.topics.map((topic) => (
                        <tr
                          key={topic.pattern}
                          className="border-t border-border align-top"
                        >
                          <td className="px-2.5 py-2">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-text-primary">
                                {topic.pattern}
                              </span>
                              <Badge tone={tone(topic.status)}>{topic.status}</Badge>
                            </div>
                            {topic.action && (
                              <p className="mt-1 max-w-sm text-text-secondary">
                                {topic.action}
                              </p>
                            )}
                          </td>
                          <td className="px-2.5 py-2 text-text-secondary">
                            {topic.receiving_topics.length > 0
                              ? topic.receiving_topics.map((name) => (
                                  <div
                                    key={name}
                                    className="font-mono text-[11px] text-text-primary"
                                  >
                                    {name}
                                  </div>
                                ))
                              : topic.summary}
                          </td>
                          <td className="px-2.5 py-2 text-text-muted">
                            {topic.matched_topics.length > 0
                              ? topic.matched_topics.map((name) => (
                                  <div key={name}>{qosLabel(topic, name)}</div>
                                ))
                              : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-1.5 text-[11px] text-text-muted">
                  “Received” means the monitor has observed at least one sample; it does
                  not prove payload validity.
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
