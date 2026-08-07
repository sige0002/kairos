// Monitor > Overview — the diagnostic landing (§11). A single glance answers
// "is capture running, is anything unhealthy, and where do I look next":
//   - record context (REC + run + elapsed, or STANDBY) from /record/status,
//   - a topic-health tally (ok / warning / danger / inactive) from the live
//     metrics, with the topics that need attention listed by name and clickable
//     straight to the Topics chart,
//   - active incidents folded from the real alert buffer,
//   - a compact system snapshot (reused SystemCard), and
//   - jump links into Topics / Signals.
// Every number is measured; each empty state explains itself (no fabrication).

import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../../api/queryKeys';
import type { AlertEvent, TopicStatus } from '../../api/types';
import type { RuntimeConfig } from '../../config';
import { Card, StatusDot } from '../../components/ui';
import { statusTone, useMonitorRows } from '../../features/monitor/useMonitorRows';
import { SystemCard } from './SystemCard';
import { useRecordStatus } from '../captures/useRecordStatus';
import { useNowClock } from './useNowClock';
import { computeRecordContext, formatElapsed } from './recordContext';
import { toAlertRows } from './alerts';

/** Statuses that warrant operator attention, worst-first. */
const ATTENTION: TopicStatus[] = ['danger', 'inactive'];

const TALLY: { status: TopicStatus; label: string }[] = [
  { status: 'ok', label: 'OK' },
  { status: 'warning', label: 'Warning' },
  { status: 'danger', label: 'Danger' },
  { status: 'inactive', label: 'Silent' },
];

function RecordContextBlock() {
  const view = useRecordStatus();
  const isPending = view.loading;
  const now = useNowClock(view.recording);
  const ctx = computeRecordContext(view, now);

  return (
    <Card className="flex flex-col gap-2 px-4 py-3.5" data-testid="overview-record">
      <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
        Recording
      </span>
      {ctx.recording ? (
        <>
          <div className="flex flex-wrap items-center gap-2.5">
            <span
              data-testid="overview-record-state"
              className="inline-flex items-center gap-1.5 rounded-chip bg-red-50 px-[7px] py-0.5 text-[10.5px] font-bold text-red-700"
            >
              <span className="h-[7px] w-[7px] animate-recpulse rounded-full bg-red-600" />
              REC
            </span>
            <span className="font-mono text-[13px] font-semibold text-gray-900">
              {ctx.runId ?? '—'}
            </span>
            <span className="font-mono text-xs text-gray-500">{formatElapsed(ctx.elapsedMs)}</span>
          </div>
          {/* The run name above is display text (§1); this is the identity the
              capture list, jobs and reports are keyed by. */}
          <span
            data-testid="overview-record-capture"
            className="font-mono text-[11px] text-gray-400"
          >
            capture {ctx.captureId ?? '— (the recorder did not name it)'}
          </span>
        </>
      ) : isPending ? (
        <span
          data-testid="overview-record-state"
          className="inline-flex w-fit rounded-chip bg-gray-100 px-[7px] py-0.5 text-[10.5px] font-bold text-gray-400"
        >
          CHECKING…
        </span>
      ) : ctx.liveKnown ? (
        <span
          data-testid="overview-record-state"
          className="inline-flex w-fit rounded-chip bg-gray-100 px-[7px] py-0.5 text-[10.5px] font-bold text-gray-500"
        >
          STANDBY
        </span>
      ) : (
        <>
          <span
            data-testid="overview-record-state"
            className="inline-flex w-fit rounded-chip bg-amber-100 px-[7px] py-0.5 text-[10.5px] font-bold text-amber-700"
          >
            LIVE STATE UNREPORTED
          </span>
          <span className="text-[11.5px] leading-relaxed text-gray-500">
            The recorder answered without its live-capture list, so it cannot be confirmed that
            nothing is recording (§10). This is not the same as an idle recorder.
          </span>
        </>
      )}
    </Card>
  );
}

export function OverviewView({
  config,
  onOpenTopics,
  onOpenSignals,
}: {
  config: RuntimeConfig;
  onOpenTopics: (topic?: string) => void;
  onOpenSignals: () => void;
}) {
  const { rows, isDiscovering } = useMonitorRows(config);

  // SSE-fed alert buffer → incidents (grouped by topic+metric).
  const { data: alerts } = useQuery<AlertEvent[]>({
    queryKey: queryKeys.alerts,
    queryFn: () => {
      throw new Error('SSE-only cache: written by useEventStream');
    },
    enabled: false,
  });
  // Reuse the shared incident collapse (one row per topic+metric, newest wins,
  // firing sorted first) rather than a second model.
  const firing = toAlertRows(alerts ?? [], 100).filter((i) => i.state === 'firing');

  const measured = rows.filter((r) => r.measured);
  const counts = TALLY.map((t) => ({
    ...t,
    n: measured.filter((r) => r.status === t.status).length,
  }));
  const attention = measured.filter((r) => r.status && ATTENTION.includes(r.status));

  return (
    <div
      className="grid flex-1 grid-cols-1 gap-2.5 overflow-auto lg:min-h-0 lg:grid-cols-[1fr_340px]"
      data-testid="monitor-overview"
    >
      <div className="flex flex-col gap-2.5">
        <RecordContextBlock />

        {/* Topic health tally + the topics that need attention */}
        <Card className="flex flex-col" data-testid="overview-health">
          <div className="flex items-center gap-2.5 border-b border-gray-100 px-4 py-3">
            <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
              Topic health
            </span>
            <div className="flex-1" />
            <span className="font-mono text-[11.5px] text-gray-400">
              {measured.length} measured · {rows.length} discovered
            </span>
          </div>

          {rows.length === 0 ? (
            <p data-testid="overview-health-empty" className="px-4 py-8 text-center text-[12.5px] text-gray-400">
              {isDiscovering
                ? 'Discovering topics on the ROS 2 graph…'
                : 'No topics discovered on the ROS 2 graph yet.'}
            </p>
          ) : measured.length === 0 ? (
            <p data-testid="overview-health-nometrics" className="px-4 py-8 text-center text-[12.5px] leading-relaxed text-gray-400">
              Topics are discovered but the monitor has no live metrics yet — health appears once
              the monitor is measuring. If it stays empty, the active robot&apos;s configured
              topics may not match what&apos;s on the graph.
            </p>
          ) : (
            <div className="flex flex-col gap-3 p-4">
              <div className="grid grid-cols-4 gap-2" data-testid="overview-tally">
                {counts.map((c) => (
                  <div
                    key={c.status}
                    data-testid={`tally-${c.status}`}
                    className="flex flex-col items-center gap-1 rounded-control border border-gray-100 bg-gray-50 py-2.5"
                  >
                    <span className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.04em] text-gray-500">
                      <StatusDot tone={statusTone(c.status)} />
                      {c.label}
                    </span>
                    <span className="font-mono text-[17px] font-bold text-gray-900">{c.n}</span>
                  </div>
                ))}
              </div>

              {attention.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-gray-500">
                    Needs attention
                  </span>
                  <div className="flex flex-col gap-1" data-testid="overview-attention">
                    {attention.map((r) => (
                      <button
                        key={r.name}
                        type="button"
                        data-testid={`attention-${r.name}`}
                        onClick={() => onOpenTopics(r.name)}
                        className="flex items-center gap-2 rounded-control border border-gray-100 px-2.5 py-2 text-left hover:bg-gray-50"
                      >
                        <StatusDot tone={statusTone(r.status)} />
                        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-gray-800">
                          {r.name}
                        </span>
                        <span className="text-[11px] font-semibold text-gray-400">{r.status}</span>
                        <span className="text-[11px] text-teal-700">chart →</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <p data-testid="overview-attention-none" className="text-[12px] text-gray-400">
                  All measured topics are on rate — nothing needs attention.
                </p>
              )}
            </div>
          )}
        </Card>

        {/* Active incidents (real alert buffer) */}
        <Card className="flex flex-col" data-testid="overview-incidents">
          <div className="flex items-center gap-2.5 border-b border-gray-100 px-4 py-3">
            <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
              Active incidents
            </span>
            <div className="flex-1" />
            <span className="font-mono text-[11.5px] text-gray-400">{firing.length} firing</span>
          </div>
          {firing.length === 0 ? (
            <p data-testid="overview-incidents-empty" className="px-4 py-6 text-center text-[12px] text-gray-400">
              No firing alerts. Threshold breaches from the monitor appear here (session-local).
            </p>
          ) : (
            <div className="flex flex-col gap-0.5 p-2.5">
              {firing.slice(0, 4).map((i) => (
                <div
                  key={i.key}
                  data-testid="overview-incident-row"
                  className="flex items-start gap-2.5 rounded-control bg-red-50 px-2.5 py-2"
                >
                  <StatusDot tone="red" className="mt-[5px]" />
                  <div className="flex min-w-0 flex-col">
                    <span className="text-[12.5px] font-semibold text-gray-700">
                      {i.title}
                      {i.detail && <span className="font-normal text-gray-400"> · {i.detail}</span>}
                    </span>
                    <span className="font-mono text-[11px] text-gray-400">firing · {i.time}</span>
                  </div>
                </div>
              ))}
              {firing.length > 4 && (
                <button
                  type="button"
                  onClick={() => onOpenTopics()}
                  className="px-2.5 py-1.5 text-left text-[11.5px] font-semibold text-teal-700 hover:underline"
                >
                  +{firing.length - 4} more — see Events →
                </button>
              )}
            </div>
          )}
        </Card>
      </div>

      <div className="flex flex-col gap-2.5">
        <SystemCard />
        <Card className="flex flex-col gap-2 p-4">
          <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
            Jump to
          </span>
          <button
            type="button"
            data-testid="overview-open-topics"
            onClick={() => onOpenTopics()}
            className="rounded-control border border-gray-200 bg-white px-3 py-2 text-left text-[12.5px] font-semibold text-teal-700 hover:bg-teal-50"
          >
            Open Topics →
          </button>
          <button
            type="button"
            data-testid="overview-open-signals"
            onClick={onOpenSignals}
            className="rounded-control border border-gray-200 bg-white px-3 py-2 text-left text-[12.5px] font-semibold text-teal-700 hover:bg-teal-50"
          >
            Open Signals →
          </button>
        </Card>
      </div>
    </div>
  );
}
