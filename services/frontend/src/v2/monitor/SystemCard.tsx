// Right-rail System card, from GET /api/v1/system. Only CPU model / core count
// and GPU name are REAL — the backend (routers/system.py) returns just
// { cpu: { model, cores }, gpu } with no utilization percentage and no storage
// endpoint. The design mock's CPU%/GPU% bar fills and "286 GB free" row were
// fabricated to fill the visual slot; per the honesty rule we DON'T show numbers
// the system can't measure, so those are dropped in favour of the real facts
// plus a one-line note. (Adding a backend utilization/storage endpoint is a
// separate decision pending with the user — no backend code added here.)

import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { Card } from '../../components/ui';

interface SystemInfoResponse {
  cpu: { model: string | null; cores: number | null };
  gpu: string | null;
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2 text-xs text-gray-500">
      <span>{label}</span>
      <div className="flex-1" />
      <span className="max-w-[180px] truncate font-mono font-semibold text-gray-700" title={value}>
        {value}
      </span>
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
      <InfoRow label="CPU" value={cpuValue} />
      <InfoRow label="GPU" value={gpuValue} />
      <p data-testid="system-note" className="text-[11px] leading-relaxed text-gray-400">
        Utilization and storage are not reported by the backend yet.
      </p>
    </Card>
  );
}
