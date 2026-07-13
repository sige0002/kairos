// Left-column always-visible cards: System status, Active warnings, Advice,
// Batch stats. System status pulls from plumbing that's already live in the
// app (SSE connection + monitor bridge from useUiStore, and the main camera's
// WebRTC phase) where trivially available; the rest is mock data, same as the
// design mock's sysRows / warnings / advice.

import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { Card, cn } from '../../components/ui';
import type { SystemInfo } from '../../api/types';
import type { SseStatus } from '../../store/uiStore';
import { ADVICE_ITEMS, type BatchMachine } from './useBatchMachine';
import { SIDE_PAD } from './compact';
import { formatBytes } from '../review/format';

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
    <span className={cn('shrink-0 self-start rounded-chip px-2 py-0.5 text-[11px] font-bold tracking-[0.03em]', CHIP_TONE[tone])}>
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

  const rows: SysRow[] = [
    matched !== null && missing !== null
      ? {
          label: 'Required data',
          value: `${matched} / ${matched + missing}`,
          chip: missing === 0 ? 'OK' : 'CHECK',
          tone: missing === 0 ? 'green' : 'amber',
        }
      : { label: 'Required data', value: '—', chip: '—', tone: 'gray' },
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
      value: recording ? 'recording' : stopping ? 'stopping' : 'standby',
      chip: recording ? 'REC' : stopping ? 'STOPPING' : 'READY',
      tone: recording ? 'red' : stopping ? 'amber' : 'teal',
    },
  ];

  return (
    <Card className={cn('flex shrink-0 flex-col gap-2 [@media(max-height:860px)]:gap-1', SIDE_PAD)}>
      <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
        System status
      </span>
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-2.5 py-0.5 [@media(max-height:860px)]:py-0">
          <span className="text-[13px] font-medium text-gray-700">{r.label}</span>
          <div className="flex-1" />
          <span className="font-mono text-xs text-gray-500">{r.value}</span>
          <Chip tone={r.tone}>{r.chip}</Chip>
        </div>
      ))}
    </Card>
  );
}

export function WarningsCard({ machine }: { machine: BatchMachine }) {
  // Driven by the REAL arming snapshot (OL-①.4), not a fabricated "camera rate
  // dropped" — the honest live warning is target topics that aren't publishing
  // while the recorder is armed/recording. Outside that window there's no live
  // signal, so the card reads "No active warnings" (never a made-up one).
  const missing = machine.arming?.missing_topics ?? [];
  const hasWarnings = missing.length > 0;
  const shown = missing.slice(0, 3);

  return (
    <Card className={cn('flex shrink-0 flex-col gap-2 [@media(max-height:860px)]:gap-1', SIDE_PAD)}>
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
          Active warnings
        </span>
        <div className="flex-1" />
        <Chip tone={hasWarnings ? 'amber' : 'gray'}>
          {hasWarnings ? `${missing.length} needs attention` : '0'}
        </Chip>
      </div>
      {hasWarnings ? (
        <>
          <div className="flex flex-col gap-0.5 rounded-control border border-amber-200 bg-amber-50 px-3 py-2.5">
            <div className="flex items-center gap-2">
              <span className="h-[7px] w-[7px] shrink-0 rounded-sm bg-amber-600" />
              <span className="text-[13px] font-semibold text-amber-800">
                {missing.length} target topic{missing.length === 1 ? '' : 's'} not publishing
              </span>
            </div>
            <span className="pl-[15px] text-xs text-amber-700">
              Recording continues, but these won't be captured until they appear.
            </span>
            <span className="truncate pl-[15px] font-mono text-[11px] text-amber-600" title={missing.join('\n')}>
              {shown.join(', ')}
              {missing.length > shown.length ? ' …' : ''}
            </span>
          </div>
          <button
            type="button"
            onClick={machine.goMonitor}
            className="rounded-control border border-gray-200 bg-white py-2 text-[12.5px] font-semibold text-teal-700 hover:bg-teal-50"
          >
            Open in Monitor →
          </button>
        </>
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
    <Card className={cn('flex shrink-0 flex-col gap-2 [@media(max-height:860px)]:gap-1', SIDE_PAD)}>
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
          <span className="text-[12.5px] font-semibold text-teal-950">{advice.title}</span>
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
      <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">Batch stats</span>
      <div className="flex gap-3.5">
        <div className="flex flex-col">
          <span data-testid="stat-recorded" className="font-mono text-lg font-semibold text-gray-900">
            {nRecorded}
          </span>
          <span className="text-[11px] text-gray-400">recorded</span>
        </div>
        <div className="flex flex-col">
          <span data-testid="stat-good" className="font-mono text-lg font-semibold text-green-600">
            {nGood}
          </span>
          <span className="text-[11px] text-gray-400">good quality</span>
        </div>
        <div className="flex flex-col">
          <span data-testid="stat-review" className="font-mono text-lg font-semibold text-amber-600">
            {nReview}
          </span>
          <span className="text-[11px] text-gray-400">needs review</span>
        </div>
        <div className="flex flex-col">
          <span data-testid="stat-task-failed" className="font-mono text-lg font-semibold text-red-600">
            {nTaskFailed}
          </span>
          <span className="text-[11px] text-gray-400">task failed</span>
        </div>
      </div>
      {/* After a Review delete the monotone "recorded" count outruns the quality
          tallies (which only cover recordings still on disk). Surface that gap
          honestly instead of letting the numbers look inconsistent. */}
      {nRecorded > nGood + nReview && (
        <p data-testid="stats-footnote" className="text-[11px] leading-snug text-gray-400">
          recorded counts every take this batch; quality tallies reflect recordings still on disk
        </p>
      )}
    </Card>
  );
}
