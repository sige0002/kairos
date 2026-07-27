// Left-column always-visible cards: System status, Active warnings, Advice,
// Batch stats. System status pulls from plumbing that's already live in the
// app (SSE connection + monitor bridge from useUiStore, and the main camera's
// WebRTC phase) where trivially available; the rest is mock data, same as the
// design mock's sysRows / warnings / advice.

import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import { Card, cn } from '../../components/ui';
import type {
  AlertEvent,
  DatasetsResponse,
  MetricsSnapshot,
  SystemInfo,
} from '../../api/types';
import { listBatches } from '../episodeBridge';
import { findTask, usePlans } from '../plans';
import type { SseStatus } from '../../store/uiStore';
import { ADVICE_ITEMS, type BatchMachine } from './useBatchMachine';
import { SIDE_PAD } from './compact';
import { formatBytes } from '../review/format';
import { armingWarning, firingAlertRows, topicRates } from './warnings';

type Tone = 'green' | 'amber' | 'red' | 'teal' | 'gray';

// Below this much free space on the data-dir filesystem we flag Storage for
// attention (amber "CHECK"). ~50 GB leaves comfortable headroom for several more
// episodes before disk pressure becomes a real risk to an in-progress batch.
const LOW_STORAGE_FREE_BYTES = 50 * 1024 ** 3;

const CHIP_TONE: Record<Tone, string> = {
  green: 'bg-green-100 text-green-700',
  amber: 'bg-amber-100 text-amber-800',
  red: 'bg-red-50 text-red-700 border border-red-200',
  teal: 'bg-teal-100 text-teal-700',
  gray: 'bg-gray-100 text-gray-500',
};

function Chip({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'shrink-0 self-start rounded-chip px-2 py-0.5 text-[11px] font-bold tracking-[0.03em]',
        CHIP_TONE[tone],
      )}
    >
      {children}
    </span>
  );
}

interface SysRow {
  label: string;
  value: string;
  chip: string;
  tone: Tone;
}

export function SystemStatusCard({
  machine,
  sseStatus,
  monitorBridge,
  camerasOk,
}: {
  machine: BatchMachine;
  sseStatus: SseStatus;
  monitorBridge: 'up' | 'down' | null;
  camerasOk: boolean;
}) {
  const robotOffline = sseStatus === 'open' && monitorBridge === 'down';
  const robotLive = sseStatus === 'open' && !robotOffline;
  // The Recorder row reads the SERVER recorder state (same /record/status query
  // the takeover card uses), so a live server-side recording always shows REC
  // here — never a stale local "READY" while the recorder is actually running.
  const recState = machine.recorderState;
  const recording = recState === 'recording';
  const stopping = recState === 'stopping';
  // Pre-armed (two-phase start): spawned + subscribed, paused until Start.
  const armed = recState === 'armed';

  // Real disk free/total for the data-dir filesystem (GET /api/v1/system). Null
  // until measured (older backend / missing data dir) -> honest "—", never a
  // fabricated figure. Polled a few seconds apart; the backend caches ~2s.
  const { data: system } = useQuery({
    queryKey: ['system'],
    queryFn: ({ signal }) => apiGet<SystemInfo>('/api/v1/system', { signal }),
    staleTime: 5000,
    refetchInterval: 5000,
  });
  const disk = system?.disk ?? null;
  const storageOk = disk != null && disk.free_bytes >= LOW_STORAGE_FREE_BYTES;
  const storageRow: SysRow = disk
    ? {
        label: 'Storage',
        value: `${formatBytes(disk.free_bytes)} free`,
        chip: storageOk ? 'OK' : 'CHECK',
        tone: storageOk ? 'green' : 'amber',
      }
    : { label: 'Storage', value: '—', chip: '—', tone: 'gray' };

  // Real arming snapshot (matched vs missing target topics) — only measured
  // while the recorder is arming/recording; outside that window it's honestly
  // unknown ("—"), never a made-up count.
  const arming = machine.arming;
  const matched = arming?.matched_topics.length ?? null;
  const missing = arming?.missing_topics.length ?? null;

  // Live "at expected rate" count from the monitor's SSE metrics snapshot
  // (read-only cache view; useEventStream writes it). Gated on the monitor
  // bridge being up so a stale last snapshot never poses as live data.
  const { data: metrics } = useQuery<MetricsSnapshot>({
    queryKey: queryKeys.metrics,
    queryFn: () => {
      throw new Error('SSE-only cache: written by useEventStream');
    },
    enabled: false,
  });
  const rates = monitorBridge === 'down' ? null : topicRates(metrics);
  const ratesRow: SysRow = rates
    ? {
        label: 'Topic rates',
        value: `${rates.ok} / ${rates.judged} at expected`,
        chip: rates.ok === rates.judged ? 'OK' : 'CHECK',
        tone: rates.ok === rates.judged ? 'green' : 'amber',
      }
    : { label: 'Topic rates', value: '—', chip: '—', tone: 'gray' };

  const rows: SysRow[] = [
    matched !== null && missing !== null
      ? {
          label: 'Required data',
          value: `${matched} / ${matched + missing}`,
          chip: missing === 0 ? 'OK' : 'CHECK',
          tone: missing === 0 ? 'green' : 'amber',
        }
      : { label: 'Required data', value: '—', chip: '—', tone: 'gray' },
    ratesRow,
    {
      // Health is measured on the main preview stream only (sub tiles run
      // their own streams but don't report here) — say that, don't invent
      // an N/M camera count.
      label: 'Cameras',
      value: camerasOk ? 'main stream OK' : 'main stream failed',
      chip: camerasOk ? 'OK' : 'CHECK',
      tone: camerasOk ? 'green' : 'amber',
    },
    {
      label: 'Robot connection',
      value: robotOffline ? 'robot offline' : robotLive ? 'connected' : sseStatus,
      chip: robotLive ? 'OK' : 'CHECK',
      tone: robotLive ? 'green' : robotOffline ? 'amber' : 'gray',
    },
    storageRow,
    {
      label: 'Recorder',
      value: recording
        ? 'recording'
        : stopping
          ? 'stopping'
          : armed
            ? 'pre-armed'
            : 'standby',
      chip: recording ? 'REC' : stopping ? 'STOPPING' : armed ? 'ARMED' : 'READY',
      tone: recording ? 'red' : stopping ? 'amber' : 'teal',
    },
  ];

  return (
    <Card
      className={cn(
        'flex shrink-0 flex-col gap-2 [@media(max-height:860px)]:gap-1',
        SIDE_PAD,
      )}
    >
      <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
        System status
      </span>
      {rows.map((r) => (
        <div
          key={r.label}
          className="flex items-center gap-2.5 py-0.5 [@media(max-height:860px)]:py-0"
        >
          <span className="text-[13px] font-medium text-gray-700">{r.label}</span>
          <div className="flex-1" />
          <span className="font-mono text-xs text-gray-500">{r.value}</span>
          <Chip tone={r.tone}>{r.chip}</Chip>
        </div>
      ))}
    </Card>
  );
}

// How many firing-alert lines the card shows before folding into "+N more".
const ALERTS_SHOWN = 2;

export function WarningsCard({
  machine,
  defaultTopics,
}: {
  machine: BatchMachine;
  defaultTopics: string[];
}) {
  // Two REAL live signals, never a fabricated one (honesty rule):
  //  - target topics the recorder is not capturing (arming snapshot, OL-①.4 —
  //    re-read live while armed, then frozen at resume as start-time coverage),
  //    reported by CAUSE so a topic that is publishing is never called dead, and
  //  - FIRING monitor alerts (threshold breaches over SSE) restricted to the
  //    recorded topics — the mid-recording degradation the snapshot can't see
  //    ("camera dropped to 12 Hz"), surfaced where the operator is looking.
  const uncaptured = armingWarning(machine.arming);
  const shown = uncaptured?.topics.slice(0, 3) ?? [];

  // Read-only view of the SSE-populated alert buffer (useEventStream writes it).
  const { data: alertBuffer } = useQuery<AlertEvent[]>({
    queryKey: queryKeys.alerts,
    queryFn: () => {
      throw new Error('SSE-only cache: written by useEventStream');
    },
    enabled: false,
  });
  const firing = firingAlertRows(alertBuffer ?? [], machine.arming, defaultTopics);
  const firingShown = firing.slice(0, ALERTS_SHOWN);

  const count = (uncaptured?.topics.length ?? 0) + firing.length;
  const hasWarnings = count > 0;

  return (
    <Card
      className={cn(
        'flex shrink-0 flex-col gap-2 [@media(max-height:860px)]:gap-1',
        SIDE_PAD,
      )}
    >
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
          Active warnings
        </span>
        <div className="flex-1" />
        <Chip tone={firing.length > 0 ? 'red' : hasWarnings ? 'amber' : 'gray'}>
          {hasWarnings ? `${count} needs attention` : '0'}
        </Chip>
      </div>
      {uncaptured && (
        <div
          data-testid="collect-uncaptured-topics"
          className="flex flex-col gap-0.5 rounded-control border border-amber-200 bg-amber-50 px-3 py-2.5"
        >
          <div className="flex items-center gap-2">
            <span className="h-[7px] w-[7px] shrink-0 rounded-sm bg-amber-600" />
            <span className="text-[13px] font-semibold text-amber-800">
              {uncaptured.title}
            </span>
          </div>
          <span className="pl-[15px] text-xs text-amber-700">{uncaptured.detail}</span>
          <span
            className="truncate pl-[15px] font-mono text-[11px] text-amber-600"
            title={uncaptured.topics.join('\n')}
          >
            {shown.join(', ')}
            {uncaptured.topics.length > shown.length ? ' …' : ''}
          </span>
        </div>
      )}
      {firing.length > 0 && (
        <div
          data-testid="collect-firing-alerts"
          className="flex flex-col gap-1 rounded-control border border-red-200 bg-red-50 px-3 py-2.5"
        >
          {firingShown.map((a) => (
            <div key={a.key} className="flex flex-col gap-0.5">
              <div className="flex items-center gap-2">
                <span className="h-[7px] w-[7px] shrink-0 rounded-sm bg-red-600" />
                <span
                  className="truncate text-[13px] font-semibold text-red-800"
                  title={a.topic}
                >
                  {a.title}
                </span>
              </div>
              <span className="pl-[15px] font-mono text-[11px] text-red-600">
                {a.detail}
                {a.detail ? ' · ' : ''}since {a.time}
              </span>
            </div>
          ))}
          {firing.length > firingShown.length && (
            <span className="pl-[15px] text-[11px] text-red-600">
              +{firing.length - firingShown.length} more in Monitor
            </span>
          )}
        </div>
      )}
      {hasWarnings ? (
        <button
          type="button"
          onClick={machine.goMonitor}
          className="rounded-control border border-gray-200 bg-white py-2 text-[12.5px] font-semibold text-teal-700 hover:bg-teal-50"
        >
          Open in Monitor →
        </button>
      ) : (
        <div className="flex items-center gap-2 py-1">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-green-100 text-xs font-bold text-green-600">
            ✓
          </span>
          <span className="text-[12.5px] text-gray-500">No active warnings</span>
        </div>
      )}
    </Card>
  );
}

export function AdviceCard({ machine }: { machine: BatchMachine }) {
  const advice = ADVICE_ITEMS[machine.adviceIdx] ?? ADVICE_ITEMS[0]!;
  const single = ADVICE_ITEMS.length <= 1;
  return (
    <Card
      className={cn(
        'flex shrink-0 flex-col gap-2 [@media(max-height:860px)]:gap-1',
        SIDE_PAD,
      )}
    >
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
          Advice for next episode
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={machine.advicePrev}
          disabled={single}
          aria-label="previous advice"
          className="flex h-[22px] w-[22px] items-center justify-center rounded-chip border border-gray-200 bg-white text-[11px] text-gray-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          ‹
        </button>
        <span className="font-mono text-[11px] text-gray-400">
          {machine.adviceIdx + 1} / {ADVICE_ITEMS.length}
        </span>
        <button
          type="button"
          onClick={machine.adviceNext}
          disabled={single}
          aria-label="next advice"
          className="flex h-[22px] w-[22px] items-center justify-center rounded-chip border border-gray-200 bg-white text-[11px] text-gray-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          ›
        </button>
      </div>
      <div className="flex flex-col gap-1 rounded-control border border-teal-200 bg-teal-50 px-3 py-2.5 [@media(max-height:860px)]:py-1.5">
        <div className="flex items-center gap-2">
          <span className="rounded-chip bg-teal-100 px-2 py-0.5 text-[10.5px] font-bold text-teal-700">
            {advice.badge}
          </span>
          <span className="text-[12.5px] font-semibold text-teal-950">
            {advice.title}
          </span>
        </div>
        {/* Full advice at roomy heights; clamped to keep the card short on laptops. */}
        <span className="text-xs leading-relaxed text-teal-700 [@media(max-height:860px)]:line-clamp-2">
          {advice.detail}
        </span>
      </div>
    </Card>
  );
}

export function BatchStatsCard({ machine }: { machine: BatchMachine }) {
  // Quality (good/review) and task result (task failed) are independent axes
  // — a task-failed episode can still count toward "good" quality, since the
  // recording itself is fine and stays usable/labeled data.
  const { nRecorded, nGood, nReview, nTaskFailed } = machine.stats;
  return (
    <Card className={cn('flex shrink-0 flex-col gap-1.5', SIDE_PAD)}>
      <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
        Set stats
      </span>
      <div className="flex gap-3.5">
        <div className="flex flex-col">
          <span
            data-testid="stat-recorded"
            className="font-mono text-lg font-semibold text-gray-900"
          >
            {nRecorded}
          </span>
          <span className="text-[11px] text-gray-400">recorded</span>
        </div>
        <div className="flex flex-col">
          <span
            data-testid="stat-good"
            className="font-mono text-lg font-semibold text-green-600"
          >
            {nGood}
          </span>
          <span className="text-[11px] text-gray-400">good quality</span>
        </div>
        <div className="flex flex-col">
          <span
            data-testid="stat-review"
            className="font-mono text-lg font-semibold text-amber-600"
          >
            {nReview}
          </span>
          <span className="text-[11px] text-gray-400">needs review</span>
        </div>
        <div className="flex flex-col">
          <span
            data-testid="stat-task-failed"
            className="font-mono text-lg font-semibold text-red-600"
          >
            {nTaskFailed}
          </span>
          <span className="text-[11px] text-gray-400">task failed</span>
        </div>
      </div>
      {/* After a Review delete the monotone "recorded" count outruns the quality
          tallies (which only cover recordings still on disk). Surface that gap
          honestly instead of letting the numbers look inconsistent. */}
      {nRecorded > nGood + nReview && (
        <p
          data-testid="stats-footnote"
          className="text-[11px] leading-snug text-gray-400"
        >
          recorded counts every take this set; quality tallies reflect recordings
          still on disk
        </p>
      )}
    </Card>
  );
}

// Mirrors the exporter's path slug (dora_runner dataset_export._sanitize_component)
// closely enough to match a dataset row's path `task` against a plan task name:
// letters/digits/underscore survive, other runs collapse to "_".
function taskSlug(task: string): string {
  return task
    .trim()
    .replace(/[^\p{L}\p{N}_.-]+/gu, '_')
    .replace(/^[._]+|[._]+$/gu, '');
}

/** Per-condition coverage for the CURRENT task — "what to record next" as a
 *  data decision (2026-07-14 batch-label decision, coverage in Collect).
 *  `recorded` sums the batches' monotone `episodes_recorded` (survives export
 *  and Review deletes); `exported` counts dataset-catalog rows whose condition
 *  and (slugged) task match. Conditions listed = the plan's ∪ those actually
 *  seen in batches, so ad-hoc conditions still show up. */
export function CoverageCard({ machine }: { machine: BatchMachine }) {
  const plans = usePlans();
  const batchesQuery = useQuery({
    queryKey: ['batches', 'coverage'],
    queryFn: () => listBatches(),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
  const datasetsQuery = useQuery({
    queryKey: queryKeys.datasets,
    queryFn: ({ signal }) => apiGet<DatasetsResponse>('/datasets', { signal }),
    staleTime: 15_000,
  });

  const task = machine.task;
  const planConditions = findTask(plans, machine.project, task).conditions;
  const batches = (batchesQuery.data?.items ?? []).filter((b) => b.task === task);
  const rowsByCondition = new Map<string, { recorded: number; exported: number }>();
  const bump = (cond: string, key: 'recorded' | 'exported', n: number) => {
    if (!cond || cond === '—') return;
    const row = rowsByCondition.get(cond) ?? { recorded: 0, exported: 0 };
    row[key] += n;
    rowsByCondition.set(cond, row);
  };
  for (const c of planConditions) bump(c, 'recorded', 0);
  for (const b of batches)
    bump(b.condition ?? '', 'recorded', b.episodes_recorded ?? 0);
  const slug = taskSlug(task);
  for (const d of datasetsQuery.data?.datasets ?? []) {
    if (d.condition && d.task === slug) bump(d.condition, 'exported', 1);
  }
  const rows = [...rowsByCondition.entries()];
  if (rows.length === 0) return null; // free-text task with no plan conditions

  return (
    <Card
      className={cn('flex shrink-0 flex-col gap-1.5', SIDE_PAD)}
      data-testid="coverage-card"
    >
      <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
        Coverage — {task}
      </span>
      <div className="flex flex-col gap-1">
        {rows.map(([cond, n]) => (
          <div
            key={cond}
            data-testid={`coverage-row-${cond}`}
            className={cn(
              'flex items-baseline gap-2 rounded-[7px] px-1.5 py-0.5',
              cond === machine.condition && 'bg-teal-50',
            )}
          >
            <span
              className={cn(
                'min-w-0 flex-1 truncate text-[11.5px]',
                cond === machine.condition
                  ? 'font-semibold text-teal-800'
                  : 'text-gray-600',
              )}
              title={cond}
            >
              {cond}
            </span>
            <span className="shrink-0 font-mono text-[11.5px] text-gray-800">
              {n.recorded}
            </span>
            <span className="shrink-0 text-[10.5px] text-gray-400">rec</span>
            <span className="shrink-0 font-mono text-[11.5px] text-gray-800">
              {n.exported}
            </span>
            <span className="shrink-0 text-[10.5px] text-gray-400">exp</span>
          </div>
        ))}
      </div>
      <p className="text-[10.5px] leading-snug text-gray-400">
        rec counts every take in this task&apos;s sets (survives export); exp =
        exported datasets with the condition label
      </p>
    </Card>
  );
}
