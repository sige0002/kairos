// Live tab (design handoff centrepiece): one operator screen that fuses Record
// + Stream + Monitor. A full-width recording "hero" on top, then a two-column
// grid — Stream previews (left) and a compact Monitor health panel (right).
// All three reuse the existing wiring; no USB-bandwidth panel (dropped by
// request — health monitoring stays payload-free, see topic_monitor design).
//
// The Monitor panel doubles as the recording-topic picker: each row has a record
// checkbox, and the checked set is what the NEXT "Start recording" captures (T-L3
// — selection for the next recording, never a mid-recording change, which
// `ros2 bag record` can't do anyway). To-be-recorded topics sort to the top.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type {
  RecordStartRequest,
  RecordStatus,
  RunDetail,
} from '../../api/types';
import type { RuntimeConfig } from '../../config';
import { ErrorMessage } from '../../components/ErrorMessage';
import { Badge, Button, Card, SectionLabel, StatusDot, cn } from '../../components/ui';
import { StreamTab } from '../stream/StreamTab';
import { useUiStore } from '../../store/uiStore';
import {
  formatBandwidth,
  formatGap,
  formatHz,
  rowTone,
  useMonitorRows,
  type MonitorData,
} from '../monitor/useMonitorRows';

// Only `recording`/`stopping` are an actually-running session — matching the
// recorder's own _ACTIVE_STATES. A fresh recorder sits in `created` (run_id=null)
// until the first start, and finished runs are `completed`/`failed`: none of
// those are "recording", so the hero must show the idle state (operator/task
// inputs + Start recording), NOT a stuck Recording state.
const ACTIVE_STATES = new Set(['recording', 'stopping']);

function formatBytes(bytes?: number): string {
  if (!bytes) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 2)} ${u[i]}`;
}

function formatElapsed(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/** Re-render once a second so the running timer advances. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function HeroMeta({
  label,
  value,
  mono,
  teal,
}: {
  label: string;
  value: string;
  mono?: boolean;
  teal?: boolean;
}) {
  return (
    <div className="whitespace-nowrap">
      <div className="text-[11px] font-medium text-gray-500">{label}</div>
      <div
        className={cn(
          'mt-0.5 text-[15.5px] font-semibold',
          mono && 'font-mono',
          teal ? 'text-teal-700' : 'text-gray-900',
        )}
      >
        {value}
      </div>
    </div>
  );
}

/** The resolved topic selection for the next recording start. */
interface RecordSelection {
  /** Explicit concrete names, or 'all' to record everything. */
  topics: string[] | 'all';
  /** How many topics that represents (for the hero label). */
  count: number;
  /** Whether the operator customized the picker (vs configured defaults). */
  customized: boolean;
}

function RecordHero({ selection }: { selection: RecordSelection }) {
  const queryClient = useQueryClient();

  const statusQuery = useQuery({
    queryKey: queryKeys.recordStatus,
    queryFn: ({ signal }) => apiGet<RecordStatus>('/record/status', { signal }),
    refetchInterval: 5000,
  });
  const status = statusQuery.data;
  const isActive = status ? ACTIVE_STATES.has(status.state) : false;
  const runId = status?.run_id ?? null;

  // While recording, pull the run detail for started_at / operator / task / topics.
  const runQuery = useQuery({
    queryKey: queryKeys.run(runId ?? ''),
    queryFn: ({ signal }) =>
      apiGet<RunDetail>(`/runs/${encodeURIComponent(runId ?? '')}`, { signal }),
    enabled: isActive && !!runId,
    refetchInterval: 10000,
  });
  const run = runQuery.data;

  const now = useNow(isActive);
  const startedMs = run?.started_at ? new Date(run.started_at).getTime() : null;
  const elapsed = startedMs ? formatElapsed(now - startedMs) : '00:00:00';

  // Persisted in the UI store so navigating away and back keeps what was typed.
  const operator = useUiStore((s) => s.recordOperator);
  const setOperator = useUiStore((s) => s.setRecordOperator);
  const task = useUiStore((s) => s.recordTask);
  const setTask = useUiStore((s) => s.setRecordTask);

  const startMutation = useMutation({
    mutationFn: (body: RecordStartRequest) => apiPost<RecordStatus>('/record/start', body),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: queryKeys.recordStatus }),
  });
  const stopMutation = useMutation({
    mutationFn: () => apiPost<RecordStatus>('/record/stop', {}),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: queryKeys.recordStatus }),
  });
  const busy = startMutation.isPending || stopMutation.isPending;

  // Disable start only when the operator explicitly cleared every topic.
  const noSelection =
    selection.customized &&
    Array.isArray(selection.topics) &&
    selection.topics.length === 0;

  function start() {
    const body: RecordStartRequest = { topics: selection.topics };
    if (operator.trim()) body.operator = operator.trim();
    if (task.trim()) body.task = task.trim();
    startMutation.mutate(body);
  }

  // Topics actually captured in this run (falls back to the selection count
  // before the run detail loads). A single count — not "n / n".
  const topicCount = run?.topics.length ?? selection.count;

  const idleTopicLabel = selection.customized
    ? `${selection.count} selected`
    : selection.topics === 'all'
      ? 'all topics'
      : `${selection.count} configured topics`;

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-7 gap-y-4 rounded-[18px] border px-6 py-[22px]',
        isActive
          ? 'border-red-200 bg-gradient-to-r from-red-50 via-rose-50 to-white shadow-float'
          : 'border-green-200 bg-gradient-to-r from-green-50 via-emerald-50 to-white shadow-card',
      )}
    >
      <div className="flex items-center gap-4">
        <span
          className={cn(
            'flex h-[46px] w-[46px] items-center justify-center rounded-full',
            isActive ? 'bg-red-50' : 'bg-green-100',
          )}
        >
          <span
            className={cn(
              'h-[15px] w-[15px] rounded-full',
              isActive ? 'animate-recpulse bg-red-600' : 'bg-green-500',
            )}
          />
        </span>
        <div>
          <div className="flex items-center gap-2.5">
            <span
              className={cn(
                'text-[12px] font-semibold uppercase tracking-[0.13em]',
                isActive ? 'text-red-600' : 'text-green-700',
              )}
            >
              {isActive ? 'Recording' : 'Idle'}
            </span>
            {isActive && runId && (
              <span className="rounded-[5px] bg-red-50 px-1.5 py-0.5 font-mono text-[12px] text-red-700">
                {runId}
              </span>
            )}
          </div>
          <div
            className={cn(
              'mt-0.5 font-mono text-[38px] leading-none',
              isActive ? 'text-gray-900' : 'text-gray-400',
            )}
          >
            {isActive ? elapsed : '00:00:00'}
          </div>
        </div>
      </div>

      {isActive ? (
        <>
          <div className="h-14 w-px bg-gray-200" />
          <div className="flex flex-wrap gap-x-8 gap-y-3">
            <HeroMeta label="Operator" value={run?.operator || '—'} />
            <HeroMeta label="Task" value={run?.task || '—'} />
            <HeroMeta label="Messages" value={(status?.message_count ?? 0).toLocaleString()} mono />
            <HeroMeta label="Size" value={formatBytes(status?.bytes)} mono />
            <HeroMeta label="Topics" value={`${topicCount}`} mono teal />
          </div>
          <div className="flex-1" />
          <Button
            type="button"
            variant="danger"
            onClick={() => stopMutation.mutate()}
            disabled={busy}
            className="px-[26px] py-[15px] text-[15px]"
          >
            <span className="h-[13px] w-[13px] rounded-[3px] bg-white" />
            {stopMutation.isPending ? 'Stopping…' : 'Stop recording'}
          </Button>
        </>
      ) : (
        <>
          <div className="hidden h-14 w-px bg-gray-200 sm:block" />
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[11px] font-medium text-gray-500">Operator</span>
              <input
                aria-label="operator"
                value={operator}
                disabled={busy}
                onChange={(e) => setOperator(e.target.value)}
                placeholder="e.g. yuki"
                className="w-36 rounded-control border border-gray-200 px-2 py-1 text-sm focus:border-teal-500 focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[11px] font-medium text-gray-500">Task</span>
              <input
                aria-label="task"
                value={task}
                disabled={busy}
                onChange={(e) => setTask(e.target.value)}
                placeholder="e.g. pick-and-place"
                className="w-44 rounded-control border border-gray-200 px-2 py-1 text-sm focus:border-teal-500 focus:outline-none"
              />
            </label>
          </div>
          <div className="flex-1" />
          <div className="flex flex-col items-end gap-1.5">
            <span className="font-mono text-[11px] text-gray-400" data-testid="record-topic-label">
              {idleTopicLabel}
            </span>
            <Button
              type="button"
              onClick={start}
              disabled={busy || noSelection}
              className="px-[26px] py-[15px] text-[15px]"
            >
              <span className="h-[11px] w-[11px] rounded-full bg-white" />
              {startMutation.isPending ? 'Starting…' : 'Start recording'}
            </Button>
            {noSelection && (
              <span className="font-mono text-[10.5px] text-amber-600">
                Select at least one topic to record
              </span>
            )}
          </div>
        </>
      )}

      {(startMutation.isError || stopMutation.isError) && (
        <div className="w-full">
          <ErrorMessage error={startMutation.error ?? stopMutation.error} />
        </div>
      )}
    </div>
  );
}

// Columns: record checkbox / topic / Hz (actual/expected) / Gap (max
// inter-arrival ms) / bandwidth. Loss is intentionally NOT shown — ROS 2
// best-effort gives no general way to compute message loss (topic_monitor
// always reports loss_rate=None), so Gap is the real measured liveness signal.
const MON_COLS = 'grid-cols-[28px_1fr_66px_52px_58px]';

function LiveMonitorPanel({
  monitor,
  selected,
  onToggle,
}: {
  monitor: MonitorData;
  selected: Set<string>;
  onToggle: (name: string) => void;
}) {
  const { rows, measuredCount, paused } = monitor;
  const total = rows.length;
  const healthy = rows.filter((r) => r.measured && !(r.loss_rate && r.loss_rate > 0)).length;
  const allHealthy = measuredCount > 0 && healthy === measuredCount;

  // To-be-recorded (checked) topics float to the top; rows are otherwise already
  // ordered (configured → measured → alphabetical) by useMonitorRows.
  const sorted = useMemo(() => {
    return [...rows].sort(
      (a, b) => Number(selected.has(b.name)) - Number(selected.has(a.name)),
    );
  }, [rows, selected]);

  return (
    <Card className="flex flex-col overflow-hidden">
      <div className="flex items-center gap-2.5 border-b border-gray-100 px-[18px] py-4">
        <SectionLabel>Monitor</SectionLabel>
        <span className="font-mono text-[11px] text-gray-400">{selected.size} to record</span>
        <div className="flex-1" />
        {paused ? (
          <Badge tone="amber">paused</Badge>
        ) : (
          <Badge tone={allHealthy ? 'green' : measuredCount === 0 ? 'gray' : 'amber'} dot>
            {measuredCount} / {total || 0} {allHealthy ? 'Healthy' : 'Monitoring'}
          </Badge>
        )}
      </div>
      <div className="flex flex-1 flex-col px-[18px] pb-4 pt-1.5">
        <div
          className={cn(
            'grid gap-2.5 border-b border-gray-100 py-2 text-[10px] uppercase tracking-[0.05em] text-gray-400',
            MON_COLS,
          )}
        >
          <span title="To record in the next session">Rec</span>
          <span>Topic</span>
          <span className="text-right">Hz</span>
          <span className="text-right">Gap</span>
          <span className="text-right">Bandwidth</span>
        </div>
        {rows.length === 0 ? (
          <p className="py-4 text-sm text-gray-500">No topics on the graph yet.</p>
        ) : (
          <div className="max-h-[420px] overflow-y-auto">
            {sorted.map((m) => {
              const tone = rowTone(m);
              const on = selected.has(m.name);
              return (
                <div
                  key={m.name}
                  className={cn(
                    'grid items-center gap-2.5 border-b border-gray-50 py-2.5',
                    MON_COLS,
                  )}
                >
                  <input
                    type="checkbox"
                    aria-label={`record ${m.name}`}
                    checked={on}
                    onChange={() => onToggle(m.name)}
                    className="h-3.5 w-3.5 cursor-pointer accent-teal-600"
                  />
                  <span className="flex min-w-0 items-center gap-2.5">
                    <StatusDot tone={tone} />
                    <span
                      className={cn(
                        'truncate font-mono text-[12.5px]',
                        on ? 'font-semibold text-gray-800' : 'text-gray-700',
                      )}
                    >
                      {m.name}
                    </span>
                  </span>
                  <span
                    className={cn(
                      'whitespace-nowrap text-right font-mono text-[12.5px] font-semibold',
                      tone === 'amber' ? 'text-amber-600' : 'text-gray-900',
                    )}
                  >
                    {formatHz(m)}
                  </span>
                  <span className="whitespace-nowrap text-right font-mono text-[11.5px] text-gray-500">
                    {formatGap(m)}
                  </span>
                  <span className="whitespace-nowrap text-right font-mono text-[11.5px] text-gray-500">
                    {formatBandwidth(m.bandwidth_bps)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Card>
  );
}

export function LiveTab({ config }: { config: RuntimeConfig }) {
  const monitor = useMonitorRows(config);
  const defaultTopics = useMemo(
    () => config.defaults.default_topics ?? [],
    [config],
  );

  // Per-topic record selection for the NEXT start. Seeded once from the
  // configured topics as discovery first arrives; the operator can then add or
  // drop any topic. Until customized, recording keeps using the configured
  // defaults (preserving glob / "all" semantics the picker can't express).
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [customized, setCustomized] = useState(false);
  const seededRef = useRef(false);

  useEffect(() => {
    if (seededRef.current || monitor.rows.length === 0) return;
    setSelected(new Set(monitor.rows.filter((r) => r.configured).map((r) => r.name)));
    seededRef.current = true;
  }, [monitor.rows]);

  const toggle = (name: string) => {
    setCustomized(true);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const selection: RecordSelection = useMemo(() => {
    if (customized) {
      return { topics: [...selected], count: selected.size, customized: true };
    }
    if (defaultTopics.length > 0) {
      return { topics: defaultTopics, count: defaultTopics.length, customized: false };
    }
    return { topics: 'all', count: 0, customized: false };
  }, [customized, selected, defaultTopics]);

  return (
    <div className="flex flex-col gap-[18px]">
      <RecordHero selection={selection} />
      <div className="grid grid-cols-1 gap-[18px] lg:grid-cols-[1.62fr_1fr]">
        <div className="min-w-0">
          <StreamTab config={config} />
        </div>
        <LiveMonitorPanel monitor={monitor} selected={selected} onToggle={toggle} />
      </div>
    </div>
  );
}
