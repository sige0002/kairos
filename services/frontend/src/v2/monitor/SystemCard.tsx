// Right-rail System gauges, restyled from the header's old SystemInfo footer
// (src/features/system/SystemInfo.tsx) into the mock's slim bars. CPU model /
// core count and GPU name are real (GET /api/v1/system); the backend exposes
// no utilization percentage or storage endpoint at all (routers/system.py only
// returns { cpu: { model, cores }, gpu }), so those two bar fills — and the
// entire Storage row — stay static mock, matching the design mock's numbers
// (same tradeoff the Collect screen's System status card already makes for
// its own "286 GB free" row).

import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { Card } from '../../components/ui';
import { teal } from '../tokens';

interface SystemInfoResponse {
  cpu: { model: string | null; cores: number | null };
  gpu: string | null;
}

const MOCK_CPU_PCT = 38;
const MOCK_GPU_PCT = 61;
const MOCK_STORAGE = { value: '286 GB free', pct: 52 };

function Gauge({ label, value, pct }: { label: string; value: string; pct: number }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 text-xs text-gray-500">
        <span>{label}</span>
        <div className="flex-1" />
        <span className="max-w-[150px] truncate font-mono font-semibold text-gray-700" title={value}>
          {value}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-gray-100">
        <span
          className="block h-full rounded-full"
          style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: teal[600] }}
        />
      </div>
    </div>
  );
}

export function SystemCard() {
  const { data } = useQuery({
    // Same query key as SystemInfo.tsx so a header instance (if any) shares the
    // cached fetch instead of duplicating it.
    queryKey: ['system'],
    queryFn: ({ signal }) => apiGet<SystemInfoResponse>('/api/v1/system', { signal }),
    staleTime: Infinity,
  });

  const cpuValue =
    data?.cpu?.cores != null
      ? `${data.cpu.cores}× ${data.cpu.model ?? 'CPU'}`
      : (data?.cpu?.model ?? '—');
  const gpuValue = data?.gpu ?? 'not detected';

  return (
    <Card className="flex shrink-0 flex-col gap-2.5 px-4 py-3.5">
      <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">System</span>
      <Gauge label="CPU" value={cpuValue} pct={MOCK_CPU_PCT} />
      <Gauge label="GPU" value={gpuValue} pct={data?.gpu ? MOCK_GPU_PCT : 0} />
      <Gauge label="Storage" value={MOCK_STORAGE.value} pct={MOCK_STORAGE.pct} />
    </Card>
  );
}
