// Honest component-health chips for the System views (Monitor + Settings).
//
// The orchestrator DOES expose a real per-component readiness view at its
// server-side `/readyz` (recorder / monitor / streamer), but that endpoint lives
// at the orchestrator ROOT and is proxied by neither the frontend's nginx nor
// the Vite dev server (only `/api/`, `/webrtc/`, `/probe/` are). So it is NOT
// reachable at the browser origin — fetching it would render a dead chip in the
// shipped topology. Instead we surface the health the browser CAN honestly
// observe from the same origin:
//   - Orchestrator: the live SSE pipe (`sseStatus`) — if it is open, the
//     orchestrator is reachable.
//   - Monitor: the orchestrator→monitor `bridge` SSE signal (`monitorBridge`),
//     which is real and browser-visible (it drives the header badge too).
// Recorder / streamer have no dedicated browser-origin health signal, so we say
// so plainly and point at where their readiness IS checked (the orchestrator's
// server-side `/readyz`, which feeds the Docker health checks / `compose ps`).

import { useUiStore, type MonitorBridge, type SseStatus } from '../../store/uiStore';
import { Badge, type Tone } from '../../components/ui';

interface Chip {
  tone: Tone;
  label: string;
}

function orchestratorChip(s: SseStatus): Chip {
  switch (s) {
    case 'open':
      return { tone: 'green', label: 'reachable' };
    case 'connecting':
      return { tone: 'amber', label: 'connecting…' };
    case 'reconnecting':
      return { tone: 'amber', label: 'reconnecting…' };
    case 'closed':
    default:
      return { tone: 'red', label: 'unreachable' };
  }
}

function monitorChip(b: MonitorBridge): Chip {
  if (b === 'up') return { tone: 'green', label: 'reachable' };
  if (b === 'down') return { tone: 'red', label: 'unreachable' };
  return { tone: 'gray', label: 'not reported' };
}

function HealthRow({ label, chip, testId }: { label: string; chip: Chip; testId: string }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-gray-600">{label}</span>
      <div className="flex-1" />
      <span data-testid={testId}>
        <Badge tone={chip.tone} dot>
          {chip.label}
        </Badge>
      </span>
    </div>
  );
}

export function ComponentHealth() {
  const sseStatus = useUiStore((s) => s.sseStatus);
  const bridge = useUiStore((s) => s.monitorBridge);

  return (
    <div className="flex flex-col gap-2.5" data-testid="component-health">
      <HealthRow
        label="Orchestrator"
        chip={orchestratorChip(sseStatus)}
        testId="health-orchestrator"
      />
      <HealthRow label="Monitor" chip={monitorChip(bridge)} testId="health-monitor" />
      <p className="text-[11.5px] leading-relaxed text-gray-500">
        Orchestrator health is this browser&apos;s live event stream (SSE); monitor health is
        the orchestrator&#8202;→&#8202;monitor bridge. Per-container recorder / streamer
        readiness is checked server-side by the orchestrator&apos;s <code>/readyz</code>{' '}
        (which feeds the Docker health checks and <code>docker compose ps</code>) and is not
        exposed at the browser origin.
      </p>
    </div>
  );
}
