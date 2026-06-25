// Live tab (design handoff centrepiece): one operator screen that fuses Record
// + Stream + Monitor. A full-width recording "hero" on top, then a two-column
// grid — Stream previews (left) and a compact Monitor health panel (right).
// All three reuse the existing wiring; no USB-bandwidth panel (dropped by
// request — health monitoring stays payload-free, see topic_monitor design).

import { useEffect, useState } from 'react';
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
import {
  formatBandwidth,
  formatGap,
  formatHz,
  rowTone,
  useMonitorRows,
} from '../monitor/useMonitorRows';

// Only `recording`/`stopping` are an actually-running session — matching the
// recorder's own _ACTIVE_STATES. A fresh recorder sits in `created` (run_id=null)
// until the first start, and finished runs are `completed`/`failed`: none of
// those are "recording", so the hero must show the idle state (operator/task
// inputs + 記録を開始), NOT a stuck 収録中.
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

function RecordHero({ config }: { config: RuntimeConfig }) {
  const queryClient = useQueryClient();
  const defaultTopics = config.defaults.default_topics ?? [];

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

  const [operator, setOperator] = useState('');
  const [task, setTask] = useState('');

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

  function start() {
    const body: RecordStartRequest = {
      // Configured topics by default; fall back to recording everything.
      topics: defaultTopics.length > 0 ? defaultTopics : 'all',
    };
    if (operator.trim()) body.operator = operator.trim();
    if (task.trim()) body.task = task.trim();
    startMutation.mutate(body);
  }

  // Topics actually captured in this run (falls back to the configured count
  // before the run detail loads). A single count — not "n / n".
  const topicCount = run?.topics.length ?? defaultTopics.length;

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
              {isActive ? '収録中' : '待機中'}
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
            <HeroMeta label="オペレーター" value={run?.operator || '—'} />
            <HeroMeta label="タスク" value={run?.task || '—'} />
            <HeroMeta label="メッセージ" value={(status?.message_count ?? 0).toLocaleString()} mono />
            <HeroMeta label="サイズ" value={formatBytes(status?.bytes)} mono />
            <HeroMeta label="トピック" value={`${topicCount}`} mono teal />
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
            {stopMutation.isPending ? '停止中…' : '記録を停止'}
          </Button>
        </>
      ) : (
        <>
          <div className="hidden h-14 w-px bg-gray-200 sm:block" />
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[11px] font-medium text-gray-500">オペレーター</span>
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
              <span className="text-[11px] font-medium text-gray-500">タスク</span>
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
            <span className="font-mono text-[11px] text-gray-400">
              {defaultTopics.length > 0
                ? `${defaultTopics.length} configured topics`
                : 'all topics'}
            </span>
            <Button
              type="button"
              onClick={start}
              disabled={busy}
              className="px-[26px] py-[15px] text-[15px]"
            >
              <span className="h-[11px] w-[11px] rounded-full bg-white" />
              {startMutation.isPending ? '開始中…' : '記録を開始'}
            </Button>
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

// Columns: topic / Hz (actual/expected) / Gap (max inter-arrival ms) / bandwidth.
// Loss is intentionally NOT shown — ROS 2 best-effort gives no general way to
// compute message loss (topic_monitor always reports loss_rate=None), so Gap is
// the real measured liveness signal instead.
const MON_COLS = 'grid-cols-[1fr_72px_64px_64px]';

function LiveMonitorPanel({ config }: { config: RuntimeConfig }) {
  const { rows, measuredCount, paused } = useMonitorRows(config);
  const total = rows.length;
  const healthy = rows.filter((r) => r.measured && !(r.loss_rate && r.loss_rate > 0)).length;
  const allHealthy = measuredCount > 0 && healthy === measuredCount;

  return (
    <Card className="flex flex-col overflow-hidden">
      <div className="flex items-center gap-2.5 border-b border-gray-100 px-[18px] py-4">
        <SectionLabel>Monitor</SectionLabel>
        <div className="flex-1" />
        {paused ? (
          <Badge tone="amber">paused</Badge>
        ) : (
          <Badge tone={allHealthy ? 'green' : measuredCount === 0 ? 'gray' : 'amber'} dot>
            {measuredCount} / {total || 0} {allHealthy ? '正常' : '監視中'}
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
          <span>トピック</span>
          <span className="text-right">Hz</span>
          <span className="text-right">Gap</span>
          <span className="text-right">帯域</span>
        </div>
        {rows.length === 0 ? (
          <p className="py-4 text-sm text-gray-500">No topics on the graph yet.</p>
        ) : (
          <div className="max-h-[420px] overflow-y-auto">
            {rows.map((m) => {
              const tone = rowTone(m);
              return (
                <div
                  key={m.name}
                  className={cn(
                    'grid items-center gap-2.5 border-b border-gray-50 py-2.5',
                    MON_COLS,
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <StatusDot tone={tone} />
                    <span className="truncate font-mono text-[12.5px] text-gray-700">
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
  return (
    <div className="flex flex-col gap-[18px]">
      <RecordHero config={config} />
      <div className="grid grid-cols-1 gap-[18px] lg:grid-cols-[1.62fr_1fr]">
        <div className="min-w-0">
          <StreamTab config={config} />
        </div>
        <LiveMonitorPanel config={config} />
      </div>
    </div>
  );
}
