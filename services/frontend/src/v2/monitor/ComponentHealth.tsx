// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
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
import { useTranslation } from 'react-i18next';

interface Chip {
  tone: Tone;
  label: string;
}

function orchestratorChip(
  s: SseStatus,
  labels: Record<'reachable' | 'connecting' | 'reconnecting' | 'unreachable', string>,
): Chip {
  switch (s) {
    case 'open':
      return { tone: 'green', label: labels.reachable };
    case 'connecting':
      return { tone: 'amber', label: labels.connecting };
    case 'reconnecting':
      return { tone: 'amber', label: labels.reconnecting };
    case 'closed':
    default:
      return { tone: 'red', label: labels.unreachable };
  }
}

function monitorChip(
  b: MonitorBridge,
  labels: Record<'reachable' | 'unreachable' | 'notReported', string>,
): Chip {
  if (b === 'up') return { tone: 'green', label: labels.reachable };
  if (b === 'down') return { tone: 'red', label: labels.unreachable };
  return { tone: 'gray', label: labels.notReported };
}

function HealthRow({
  label,
  chip,
  testId,
}: {
  label: string;
  chip: Chip;
  testId: string;
}) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-text-secondary">{label}</span>
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
  const { t } = useTranslation('monitor');
  const sseStatus = useUiStore((s) => s.sseStatus);
  const bridge = useUiStore((s) => s.monitorBridge);

  return (
    <div className="flex flex-col gap-2.5" data-testid="component-health">
      <HealthRow
        label={t('health.orchestrator')}
        chip={orchestratorChip(sseStatus, {
          reachable: t('health.reachable'),
          connecting: t('health.connecting'),
          reconnecting: t('health.reconnecting'),
          unreachable: t('health.unreachable'),
        })}
        testId="health-orchestrator"
      />
      <HealthRow
        label={t('health.monitor')}
        chip={monitorChip(bridge, {
          reachable: t('health.reachable'),
          unreachable: t('health.unreachable'),
          notReported: t('health.notReported'),
        })}
        testId="health-monitor"
      />
      <p className="text-[11.5px] leading-relaxed text-text-muted">
        {t('health.explanation')}
      </p>
    </div>
  );
}
