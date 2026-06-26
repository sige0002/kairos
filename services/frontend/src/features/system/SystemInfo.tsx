// Compact host CPU/GPU readout for the app header (under the connection badge).
// Read-only operator context: it fetches GET /api/v1/system once and renders a
// small mono line. GPU is omitted when the host has none. Any fetch failure
// renders nothing (the header simply omits the line) — this is informational
// and must never disrupt the shell.

import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { cn } from '../../components/ui';

/** Response shape of GET /api/v1/system (mirrors routers/system.py). */
export interface SystemInfoResponse {
  cpu: { model: string | null; cores: number | null };
  gpu: string | null;
}

/** One labelled mono fact, e.g. "CPU 32× Intel…". */
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="font-semibold uppercase tracking-[0.04em] text-gray-400">
        {label}
      </span>
      <span className="text-gray-600">{value}</span>
    </span>
  );
}

export function SystemInfo({ className }: { className?: string }) {
  const { data } = useQuery({
    // Inline key (intentionally not in the shared queryKeys registry): this is a
    // one-off, header-only fact with no invalidation needs.
    queryKey: ['system'],
    queryFn: ({ signal }) => apiGet<SystemInfoResponse>('/api/v1/system', { signal }),
    // Host facts are effectively static for the session; don't refetch on focus.
    staleTime: Infinity,
  });

  if (!data) return null;

  // Tolerate a malformed/partial payload (e.g. a stubbed backend) so the header
  // never crashes: treat missing fields as null.
  const model = data.cpu?.model ?? null;
  const cores = data.cpu?.cores ?? null;
  const gpu = data.gpu ?? null;

  const cpuValue =
    model !== null && cores !== null
      ? `${cores}× ${model}`
      : (model ?? (cores !== null ? `${cores} cores` : null));

  // Nothing useful resolved (no model, no cores, no gpu) -> render nothing.
  if (cpuValue === null && gpu === null) return null;

  return (
    <div
      data-testid="system-info"
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] leading-tight',
        className,
      )}
    >
      {cpuValue !== null && <Fact label="CPU" value={cpuValue} />}
      {gpu !== null && <Fact label="GPU" value={gpu} />}
    </div>
  );
}
