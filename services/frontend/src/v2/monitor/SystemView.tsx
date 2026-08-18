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

function Row({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="flex items-baseline gap-3 text-[12.5px]">
      <span className="text-gray-500">{label}</span>
      <div className="flex-1" />
      <span
        data-testid={testId}
        className="max-w-[60%] truncate text-right font-mono font-semibold text-gray-800"
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

function Meter({ label, percent, testId }: { label: string; percent: number; testId?: string }) {
  const pct = Math.max(0, Math.min(100, percent));
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between text-[11.5px] text-gray-500">
        <span>{label}</span>
        <span data-testid={testId} className="font-mono font-semibold text-gray-700">
          {pct.toFixed(0)}%
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-gray-100">
        <div className="h-full rounded-full bg-teal-500" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="flex flex-col gap-3 px-4 py-3.5">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
        {title}
      </h2>
      {children}
    </Card>
  );
}

export function SystemView({ config }: { config: RuntimeConfig }) {
  const { data } = useQuery({
    queryKey: ['system'],
    queryFn: ({ signal }) => getSystemInfo({ signal }),
    staleTime: SYSTEM_INFO_POLL_MS,
    refetchInterval: SYSTEM_INFO_POLL_MS,
  });

  const cpuValue =
    data?.cpu?.cores != null
      ? `${data.cpu.cores}× ${data.cpu.model ?? 'CPU'}`
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
      <Panel title="Host">
        <Row label="CPU" value={cpuValue} testId="sys-cpu" />
        {data?.cpu_percent != null && (
          <Meter label="CPU load" percent={data.cpu_percent} testId="sys-cpu-load" />
        )}
        <Row label="GPU" value={data?.gpu ?? 'not detected'} testId="sys-gpu" />
        {data?.gpu_percent != null && (
          <Meter label="GPU load" percent={data.gpu_percent} testId="sys-gpu-load" />
        )}
      </Panel>

      <Panel title="Storage">
        {disk ? (
          <>
            <Row label="Data dir" value={disk.path} testId="sys-disk-path" />
            <Row
              label="Free"
              value={`${formatBytes(disk.free_bytes)} of ${formatBytes(disk.total_bytes)}`}
              testId="sys-disk-free"
            />
            {usedPct != null && <Meter label="Used" percent={usedPct} testId="sys-disk-used" />}
          </>
        ) : (
          <p className="text-[12.5px] text-gray-500">
            Disk usage unavailable — the runtime data dir could not be measured.
          </p>
        )}
      </Panel>

      <Panel title="Runtime">
        <Row label="Robot" value={robot || '—'} testId="sys-robot" />
        <Row
          label="ROS_DOMAIN_ID"
          value={domain !== undefined ? String(domain) : '—'}
          testId="sys-domain"
        />
        <Row label="API base" value={endpoints.api} testId="sys-api" />
        <Row label="Events (SSE)" value={endpoints.events} testId="sys-events" />
        <Row label="WebRTC" value={endpoints.webrtc} testId="sys-webrtc" />
      </Panel>

      <Panel title="Component health">
        <ComponentHealth />
      </Panel>
    </div>
  );
}
