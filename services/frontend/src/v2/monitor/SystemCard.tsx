// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Right-rail System card, from GET /api/v1/system. Shows the host's static
// facts (CPU model / core count, GPU name) plus live utilization the backend now
// measures: CPU busy %, GPU % (only when a GPU is present), and data-dir storage
// free/total. Each utilization field is optional — when the backend can't
// measure it (older build, no GPU, missing data dir, first CPU sample) we render
// an honest "—" / omit the bar rather than a fabricated number.

import { useQuery } from '@tanstack/react-query';
import { getSystemInfo } from '../../api/system';
import { SYSTEM_INFO_POLL_MS } from '../pollingPolicy';
import { Card } from '../../components/ui';
import { formatBytes } from '../review/format';
import { useTranslation } from 'react-i18next';

// The 'system' query key is shared with the header readout (which stays static).

function InfoRow({
  label,
  value,
  testId,
}: {
  label: string;
  value: string;
  testId?: string;
}) {
  return (
    <div className="flex items-baseline gap-2 text-xs text-text-muted">
      <span>{label}</span>
      <div className="flex-1" />
      {/* `truncate` clips on BOTH axes, and at `text-xs` the default 16px line
          box is a hair shorter than this mono face's ascent+descent — measured
          2px of the glyphs cut off, which eats a descender or an accent
          depending on the font stack. Line-height rounding, not a layout
          failure: `leading-normal` gives the line box the 2px it was short. */}
      <span
        data-testid={testId}
        className="max-w-[180px] truncate font-mono font-semibold leading-normal text-text-primary"
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
      <div className="flex items-baseline justify-between text-[11px] text-text-muted">
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

export function SystemCard() {
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
  const gpuValue = data?.gpu ?? t('system.notDetected');
  const cpuPercent = data?.cpu_percent ?? null;
  const gpuPercent = data?.gpu_percent ?? null;
  const disk = data?.disk ?? null;
  const storageValue = disk
    ? t('system.storageSummary', {
        free: formatBytes(disk.free_bytes),
        total: formatBytes(disk.total_bytes),
      })
    : '—';

  return (
    <Card className="flex shrink-0 flex-col gap-2.5 px-4 py-3.5">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-muted">
        {t('screen.nav.System')}
      </h2>
      <InfoRow label={t('system.cpu')} value={cpuValue} />
      {cpuPercent != null && (
        <Meter label={t('system.cpuLoad')} percent={cpuPercent} testId="cpu-load" />
      )}
      <InfoRow label={t('system.gpu')} value={gpuValue} />
      {gpuPercent != null && (
        <Meter label={t('system.gpuLoad')} percent={gpuPercent} testId="gpu-load" />
      )}
      <InfoRow
        label={t('system.storage')}
        value={storageValue}
        testId="system-storage"
      />
    </Card>
  );
}
