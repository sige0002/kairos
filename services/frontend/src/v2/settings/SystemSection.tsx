// Settings > System — read-only deployment facts. ROS_DOMAIN_ID + robot from the
// runtime config, the service endpoints the browser talks to, the runtime data
// dir + free space from GET /api/v1/system, and the honest component health
// (shared ComponentHealth — see it for why /readyz isn't fetched here). No
// product-version row: there is no honest client-side version source, and the
// spec (§12) forbids inventing one, so it is omitted. RMW / DDS transport is not
// exposed by the API either, and we say so rather than guessing.

import { useQuery } from '@tanstack/react-query';
import { getSystemInfo } from '../../api/system';
import type { RuntimeConfig } from '../../config';
import { Card } from '../../components/ui';
import { formatBytes } from '../review/format';
import { ComponentHealth } from '../monitor/ComponentHealth';

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-3 text-[12.5px]">
      <span className="text-gray-500">{label}</span>
      <div className="flex-1" />
      <span className="max-w-[60%] truncate text-right font-mono font-semibold text-gray-800" title={value}>
        {value}
      </span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-[13px] font-semibold uppercase tracking-[0.04em] text-gray-500">{title}</h3>
      {children}
    </div>
  );
}

export function SystemSection({ config }: { config: RuntimeConfig | undefined }) {
  const { data } = useQuery({
    queryKey: ['system'],
    queryFn: ({ signal }) => getSystemInfo({ signal }),
    staleTime: 5000,
    refetchInterval: 5000,
  });

  const disk = data?.disk ?? null;
  const domain = config?.defaults.ros_domain_id;
  const endpoints = config?.endpoints;

  return (
    <Card className="flex min-w-0 flex-col gap-5 overflow-auto p-[18px] lg:col-span-2" data-testid="settings-system">
      <div className="flex items-center gap-2.5">
        <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
          System
        </span>
        <span className="text-[11px] text-gray-400">read-only · GET /api/v1/config</span>
      </div>

      <Section title="Deployment">
        <Row label="Robot" value={config?.defaults.robot_name || '—'} />
        <Row label="ROS_DOMAIN_ID" value={domain !== undefined ? String(domain) : '—'} />
        <p className="text-[11.5px] text-gray-400">
          RMW / DDS transport is not exposed by the API — check <code>RMW_IMPLEMENTATION</code> in
          the service environment.
        </p>
      </Section>

      <Section title="Service endpoints">
        <Row label="API base" value={endpoints?.api ?? '—'} />
        <Row label="Events (SSE)" value={endpoints?.events ?? '—'} />
        <Row label="WebRTC" value={endpoints?.webrtc ?? '—'} />
      </Section>

      <Section title="Storage">
        {disk ? (
          <>
            <Row label="Data dir" value={disk.path} />
            <Row
              label="Free"
              value={`${formatBytes(disk.free_bytes)} of ${formatBytes(disk.total_bytes)}`}
            />
          </>
        ) : (
          <p className="text-[12.5px] text-gray-400">
            Disk usage unavailable — the runtime data dir could not be measured.
          </p>
        )}
      </Section>

      <Section title="Component health">
        <ComponentHealth />
      </Section>
    </Card>
  );
}
