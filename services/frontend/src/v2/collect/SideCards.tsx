// Left-column always-visible cards: System status, Active warnings, Advice,
// Batch stats. System status pulls from plumbing that's already live in the
// app (SSE connection + monitor bridge from useUiStore, and the main camera's
// WebRTC phase) where trivially available; the rest is mock data, same as the
// design mock's sysRows / warnings / advice.

import { Card, cn } from '../../components/ui';
import type { SseStatus } from '../../store/uiStore';
import { ADVICE_ITEMS, type BatchMachine } from './useBatchMachine';

type Tone = 'green' | 'amber' | 'red' | 'teal' | 'gray';

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
  const recording = machine.phase === 'recording';
  const saving = machine.phase === 'saving' || machine.phase === 'quickcheck';

  const rows: SysRow[] = [
    { label: 'Required data', value: '12 / 12', chip: 'OK', tone: 'green' },
    {
      label: 'Cameras',
      value: camerasOk ? '3 / 3' : '2 / 3 healthy',
      chip: camerasOk ? 'OK' : 'CHECK',
      tone: camerasOk ? 'green' : 'amber',
    },
    {
      label: 'Robot connection',
      value: robotOffline ? 'robot offline' : robotLive ? 'connected' : sseStatus,
      chip: robotLive ? 'OK' : 'CHECK',
      tone: robotLive ? 'green' : robotOffline ? 'amber' : 'gray',
    },
    { label: 'Storage', value: '286 GB free', chip: 'OK', tone: 'green' },
    {
      label: 'Recorder',
      value: recording ? 'recording' : saving ? 'saving' : 'standby',
      chip: recording ? 'REC' : 'READY',
      tone: recording ? 'red' : 'teal',
    },
  ];

  return (
    <Card className="flex shrink-0 flex-col gap-2 p-[13px] px-[18px]">
      <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
        System status
      </span>
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-2.5 py-0.5">
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
  const hasWarnings = machine.recWarning;
  const elapsedText = (() => {
    const s = Math.floor(machine.elapsedMs / 1000);
    return `00:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  })();

  return (
    <Card className="flex shrink-0 flex-col gap-2 p-[13px] px-[18px]">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
          Active warnings
        </span>
        <div className="flex-1" />
        <Chip tone={hasWarnings ? 'amber' : 'gray'}>{hasWarnings ? '1 needs attention' : '0'}</Chip>
      </div>
      {hasWarnings ? (
        <>
          <div className="flex flex-col gap-0.5 rounded-control border border-amber-200 bg-amber-50 px-3 py-2.5">
            <div className="flex items-center gap-2">
              <span className="h-[7px] w-[7px] shrink-0 rounded-sm bg-amber-600" />
              <span className="text-[13px] font-semibold text-amber-800">Right camera update rate is low</span>
            </div>
            <span className="pl-[15px] text-xs text-amber-700">
              Recording can continue — this episode will be flagged for review.
            </span>
            <span className="pl-[15px] font-mono text-[11px] text-amber-600">{elapsedText} → ongoing</span>
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
    <Card className="flex shrink-0 flex-col gap-2 p-[13px] px-[18px]">
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
      <div className="flex flex-col gap-1 rounded-control border border-teal-200 bg-teal-50 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="rounded-chip bg-teal-100 px-2 py-0.5 text-[10.5px] font-bold text-teal-700">
            {advice.badge}
          </span>
          <span className="text-[12.5px] font-semibold text-teal-950">{advice.title}</span>
        </div>
        <span className="text-xs leading-relaxed text-teal-700">{advice.detail}</span>
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
    <Card className="flex shrink-0 flex-col gap-1.5 p-[13px] px-[18px]">
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
    </Card>
  );
}
