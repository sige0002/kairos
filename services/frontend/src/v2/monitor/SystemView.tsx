// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Monitor > System — the full-page host + deployment view (§11). Everything is
// real: host facts + live utilization from GET /api/v1/system (CPU model/cores,
// GPU or "not detected", disk path/free/total, CPU%/GPU% when measurable),
// the runtime ROS_DOMAIN_ID + service endpoints from GET /api/v1/config, and the
// browser-observable component health (see ComponentHealth — honest about what
// /readyz can and can't tell the browser). Utilization refreshes on the same ~5s
// cadence as the right-rail SystemCard (they share the 'system' query key).

import { useQuery } from '@tanstack/react-query';
import { getSystemInfo } from '../../api/system';
import { SYSTEM_INFO_POLL_MS } from '../pollingPolicy';
import type { RuntimeConfig } from '../../config';
import { Card } from '../../components/ui';
import { formatBytes } from '../review/format';
import { ComponentHealth } from './ComponentHealth';
import { useTranslation } from 'react-i18next';

function Row({
  label,
  value,
  testId,
}: {
  label: string;
  value: string;
  testId?: string;
}) {
  return (
    <div className="flex items-baseline gap-3 text-[12.5px]">
      <span className="text-text-muted">{label}</span>
      <div className="flex-1" />
      <span
        data-testid={testId}
        className="max-w-[60%] truncate text-right font-mono font-semibold text-text-primary"
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

function Meter({
  label,
  percent,
  testId,
}: {
  label: string;
  percent: number;
  testId?: string;
}) {
  const pct = Math.max(0, Math.min(100, percent));
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between text-[11.5px] text-text-muted">
        <span>{label}</span>
        <span
          data-testid={testId}
          className="font-mono font-semibold text-text-primary"
        >
          {pct.toFixed(0)}%
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-muted">
        <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="flex flex-col gap-3 px-4 py-3.5">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-muted">
        {title}
      </h2>
      {children}
    </Card>
  );
}

export function SystemView({ config }: { config: RuntimeConfig }) {
  const { t } = useTranslation('monitor');
  const { data } = useQuery({
    queryKey: ['system'],
    queryFn: ({ signal }) => getSystemInfo({ signal }),
    staleTime: SYSTEM_INFO_POLL_MS,
    refetchInterval: SYSTEM_INFO_POLL_MS,
  });

  const cpuValue =
    data?.cpu?.cores != null
      ? `${data.cpu.cores}× ${data.cpu.model ?? t('system.cpu')}`
      : (data?.cpu?.model ?? '—');
  const disk = data?.disk ?? null;
  const usedPct =
    disk && disk.total_bytes > 0
      ? (100 * (disk.total_bytes - disk.free_bytes)) / disk.total_bytes
      : null;

  const domain = config.defaults.ros_domain_id;
  const robot = config.defaults.robot_name;
  const endpoints = config.endpoints;

  return (
    <div
      className="grid flex-1 grid-cols-1 gap-2.5 overflow-auto lg:min-h-0 lg:auto-rows-min lg:grid-cols-2"
      data-testid="monitor-system"
    >
      <Panel title={t('system.host')}>
        <Row label={t('system.cpu')} value={cpuValue} testId="sys-cpu" />
        {data?.cpu_percent != null && (
          <Meter
            label={t('system.cpuLoad')}
            percent={data.cpu_percent}
            testId="sys-cpu-load"
          />
        )}
        <Row
          label={t('system.gpu')}
          value={data?.gpu ?? t('system.notDetected')}
          testId="sys-gpu"
        />
        {data?.gpu_percent != null && (
          <Meter
            label={t('system.gpuLoad')}
            percent={data.gpu_percent}
            testId="sys-gpu-load"
          />
        )}
      </Panel>

      <Panel title={t('system.storage')}>
        {disk ? (
          <>
            <Row label={t('system.dataDir')} value={disk.path} testId="sys-disk-path" />
            <Row
              label={t('system.free')}
              value={t('system.freeOf', {
                free: formatBytes(disk.free_bytes),
                total: formatBytes(disk.total_bytes),
              })}
              testId="sys-disk-free"
            />
            {usedPct != null && (
              <Meter
                label={t('system.used')}
                percent={usedPct}
                testId="sys-disk-used"
              />
            )}
          </>
        ) : (
          <p className="text-[12.5px] text-text-muted">{t('system.diskUnavailable')}</p>
        )}
      </Panel>

      <Panel title={t('system.runtime')}>
        <Row label={t('system.robot')} value={robot || '—'} testId="sys-robot" />
        <Row
          label="ROS_DOMAIN_ID"
          value={domain !== undefined ? String(domain) : '—'}
          testId="sys-domain"
        />
        <Row label={t('system.apiBase')} value={endpoints.api} testId="sys-api" />
        <Row label={t('system.events')} value={endpoints.events} testId="sys-events" />
        <Row label="WebRTC" value={endpoints.webrtc} testId="sys-webrtc" />
      </Panel>

      <Panel title={t('system.componentHealth')}>
        <ComponentHealth />
      </Panel>
    </div>
  );
}
