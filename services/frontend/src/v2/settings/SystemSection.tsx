// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Settings > System — read-only deployment facts. ROS_DOMAIN_ID + robot from the
// runtime config, the service endpoints the browser talks to, the runtime data
// dir + free space from GET /api/v1/system, and the honest component health.
// Generated-file cleanup lives in Settings > Data.
// (shared ComponentHealth — see it for why /readyz isn't fetched here). No
// product-version row: there is no honest client-side version source, and the
// spec (§12) forbids inventing one, so it is omitted. RMW / DDS transport is not
// exposed by the API either, and we say so rather than guessing.

import { useQuery } from '@tanstack/react-query';
import { getSystemInfo } from '../../api/system';
import { SYSTEM_INFO_POLL_MS } from '../pollingPolicy';
import type { RuntimeConfig } from '../../config';
import { Card } from '../../components/ui';
import { formatBytes } from '../review/format';
import { ComponentHealth } from '../monitor/ComponentHealth';
import { useTranslation } from 'react-i18next';

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-3 text-[12.5px]">
      <span className="text-text-muted">{label}</span>
      <div className="flex-1" />
      <span
        className="max-w-[60%] truncate text-right font-mono font-semibold text-text-primary"
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-[13px] font-semibold uppercase tracking-[0.04em] text-text-muted">
        {title}
      </h3>
      {children}
    </div>
  );
}

export function SystemSection({ config }: { config: RuntimeConfig | undefined }) {
  const { t } = useTranslation('settings');
  const { data } = useQuery({
    queryKey: ['system'],
    queryFn: ({ signal }) => getSystemInfo({ signal }),
    staleTime: 5000,
    refetchInterval: SYSTEM_INFO_POLL_MS,
  });

  const disk = data?.disk ?? null;
  const domain = config?.defaults.ros_domain_id;
  const endpoints = config?.endpoints;

  return (
    <Card
      className="flex min-w-0 flex-col gap-5 overflow-auto p-[18px] lg:col-span-2"
      data-testid="settings-system"
    >
      <div className="flex items-center gap-2.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-muted">
          {t('system.title')}
        </h2>
        <span className="text-[11px] text-text-muted">{t('system.facts')}</span>
      </div>

      <Section title={t('system.deployment')}>
        <Row label={t('system.robot')} value={config?.defaults.robot_name || '—'} />
        <Row
          label={t('system.rosDomain')}
          value={domain !== undefined ? String(domain) : '—'}
        />
        <p className="text-[11.5px] text-text-muted">{t('system.rmwNote')}</p>
      </Section>

      <Section title={t('system.serviceEndpoints')}>
        <Row label={t('system.apiBase')} value={endpoints?.api ?? '—'} />
        <Row label={t('system.events')} value={endpoints?.events ?? '—'} />
        <Row label={t('system.webRtc')} value={endpoints?.webrtc ?? '—'} />
      </Section>

      <Section title={t('system.storage')}>
        {disk ? (
          <>
            <Row label={t('system.dataDir')} value={disk.path} />
            <Row
              label={t('system.free')}
              value={t('system.freeOf', {
                free: formatBytes(disk.free_bytes),
                total: formatBytes(disk.total_bytes),
              })}
            />
          </>
        ) : (
          <p className="text-[12.5px] text-text-muted">{t('system.diskUnavailable')}</p>
        )}
      </Section>

      <Section title={t('system.componentHealth')}>
        <ComponentHealth />
      </Section>
    </Card>
  );
}
