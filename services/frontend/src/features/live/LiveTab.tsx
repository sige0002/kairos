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

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiGet, apiPost } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type {
  AlertEvent,
  ConfigOptions,
  RecordArming,
  RecordStartRequest,
  RecordStatus,
  RunDetail,
} from '../../api/types';
import type { RuntimeConfig } from '../../config';
import { ErrorMessage } from '../../components/ErrorMessage';
import { Badge, Button, Card, Modal, SectionLabel, StatusDot, cn } from '../../components/ui';
import { StreamTab } from '../stream/StreamTab';
import { useUiStore } from '../../store/uiStore';
import {
  formatBandwidth,
  formatGap,
  formatHz,
  formatRateShortfall,
  rowReason,
  rowTone,
  useMonitorRows,
  type MonitorData,
} from '../monitor/useMonitorRows';
import { useMetricHistory } from '../graph/useMetricHistory';
import { ScopeBand } from './scope/ScopeBand';

/** A REC/STOP recording marker, drawn on every Scope band panel. Lives here
 *  (where `useRecordMarkers` is defined) — the uiStore imports this type. */
export interface RecMarker {
  t: number;
  kind: 'REC' | 'STOP';
}

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
    // Re-baseline on activation: `now` may be stale from mount (the interval
    // only runs while active), which would mis-show the first second.
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

// REC/STOP markers for the live health graph (OL-③.2): log each recording
// start/stop transition. Shares the `/record/status` query cache with RecordHero
// (react-query dedupes by key), so this adds no extra network. Markers older than
// the longest graph window are trimmed.
function useRecordMarkers(): RecMarker[] {
  const { data } = useQuery({
    queryKey: queryKeys.recordStatus,
    queryFn: ({ signal }) => apiGet<RecordStatus>('/record/status', { signal }),
    refetchInterval: 5000,
  });
  // Markers + the active-edge bookkeeping live in the UI store so they survive
  // the Live tab unmounting on navigation (the graph + its history must persist).
  const markers = useUiStore((s) => s.recMarkers);
  const pushMarker = useUiStore((s) => s.pushRecordMarker);
  useEffect(() => {
    if (data) pushMarker(data.state);
  }, [data, pushMarker]);
  return markers;
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

// Shown while POST /record/start blocks through the recorder's arming gate.
// The strip says why the click "hangs" for a few seconds — a selected topic
// with no publisher waits out the full subscription-readiness timeout.
function StartingNote() {
  return (
    <div className="w-full" data-testid="starting-note">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-control border border-amber-200 bg-amber-50/70 px-3 py-2 text-[12px] text-amber-800">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.09em]">
          Arming
        </span>
        <span className="font-mono text-[11px] opacity-80">
          subscribing to the selected topics before capture starts — topics with
          no publisher hold the gate until its readiness timeout
        </span>
      </div>
    </div>
  );
}

// Arming result (OL-①.4): when a `--start-paused` recording armed, the recorder
// reports which target topics it matched on the ROS graph vs which were still
// missing when it resumed. A non-empty `missing` is the useful signal — the gate
// timed out and resumed anyway, so those topics were not yet publishing.
//
// Only the FINAL snapshot is reachable here: /record/start holds the recorder's
// session lock and blocks through the arming gate, so the UI never observes the
// live `active`/`resume_at` countdown phase — we render just the matched/missing
// summary (the `active` and `resume_at` fields are reserved for a future async
// start that streams arming progress).
function ArmingNote({ arming }: { arming: RecordArming }) {
  const matched = arming.matched_topics ?? [];
  // Both not-captured causes: no publisher, and published-but-not-subscribed.
  const missing = [
    ...(arming.missing_topics ?? []),
    ...(arming.unsubscribed_topics ?? []),
  ];
  if (matched.length === 0 && missing.length === 0) return null;
  const ok = missing.length === 0;
  const shown = missing.slice(0, 4);
  return (
    <div className="w-full" data-testid="arming-note">
      <div
        className={cn(
          'flex flex-wrap items-center gap-x-3 gap-y-1 rounded-control border px-3 py-2 text-[12px]',
          ok
            ? 'border-teal-200 bg-teal-50/60 text-teal-800'
            : 'border-amber-200 bg-amber-50/70 text-amber-800',
        )}
      >
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.09em]">
          Armed
        </span>
        <span className="font-mono">{matched.length} matched</span>
        {missing.length > 0 && (
          <>
            <span className="opacity-40">·</span>
            <span className="font-mono font-semibold">{missing.length} missing</span>
            <span
              className="truncate font-mono text-[11px] opacity-80"
              title={missing.join('\n')}
            >
              {shown.join(', ')}
              {missing.length > shown.length ? ' …' : ''}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

// Recording-integrity badge (OL-①): shown after a session ends when the
// recorder either lost messages to its in-recorder cache (`dropped`, the bag is
// missing data even though the run "completed") or failed verification
// (`failed`). A clean `ok`/`unknown` run renders nothing — this is a problem
// banner, not a status line. OpenLUTRA surfaces no drop signal at all.
function IntegrityNote({ status }: { status: RecordStatus }) {
  const integrity = status.integrity;
  if (integrity !== 'dropped' && integrity !== 'failed') return null;
  const dropped = status.dropped_messages ?? null;
  const failed = integrity === 'failed';
  return (
    <div className="w-full" data-testid="integrity-note">
      <div
        className={cn(
          'flex flex-wrap items-center gap-x-3 gap-y-1 rounded-control border px-3 py-2 text-[12px]',
          failed
            ? 'border-red-200 bg-red-50/70 text-red-800'
            : 'border-amber-200 bg-amber-50/70 text-amber-800',
        )}
      >
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.09em]">
          {failed ? 'Recording failed' : 'Data dropped'}
        </span>
        {failed ? (
          <span className="font-mono text-[11px]">bag unreadable / not verified</span>
        ) : (
          <>
            <span className="font-mono font-semibold">
              {dropped !== null ? dropped.toLocaleString() : '?'} messages lost
            </span>
            <span className="opacity-40">·</span>
            <span className="font-mono text-[11px] opacity-80">
              recorder cache overflowed — raise max_cache_size_mb
            </span>
          </>
        )}
      </div>
    </div>
  );
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

  // Tick only while actually capturing: during `stopping` the session has
  // already ended (the recorder stamps ended_at at the stop decision), so the
  // display freezes at the operator's stop instead of ticking through the
  // SIGINT flush and overshooting the duration that gets persisted.
  const now = useNow(status?.state === 'recording');
  // Timer baseline: the recorder-stamped capture start, carried on the same
  // /record/status poll that flips the hero to red — so the timer reads ~0 the
  // moment red appears (no wait for the run-detail fetch, which is a fallback).
  const startedIso = status?.started_at ?? run?.started_at ?? null;
  const startedMs = startedIso ? new Date(startedIso).getTime() : null;
  const elapsed = startedMs ? formatElapsed(now - startedMs) : '00:00:00';

  // Persisted in the UI store so navigating away and back keeps what was typed.
  const operator = useUiStore((s) => s.recordOperator);
  const setOperator = useUiStore((s) => s.setRecordOperator);
  const task = useUiStore((s) => s.recordTask);
  const setTask = useUiStore((s) => s.setRecordTask);

  // After Stop, prompt to keep or discard the just-finished run (its id from the
  // stop response, falling back to the run active when Stop was pressed).
  const [pendingReview, setPendingReview] = useState<string | null>(null);

  // A recorder-rejected start comes back as HTTP 200 with the kept run row in
  // `failed` (the orchestrator preserves the row as the audit trail), so the
  // response BODY — not the HTTP status — says whether capture began. Without
  // checking it, a failed start just snaps the hero back to Idle with no
  // explanation (the "recording silently never happened" report).
  const [startFailure, setStartFailure] = useState<RunDetail | null>(null);
  const startMutation = useMutation({
    mutationFn: (body: RecordStartRequest) => apiPost<RunDetail>('/record/start', body),
    onMutate: () => setStartFailure(null),
    onSuccess: (run) => {
      if (run?.state === 'failed') setStartFailure(run);
      void queryClient.invalidateQueries({ queryKey: queryKeys.recordStatus });
    },
  });
  const stopMutation = useMutation({
    mutationFn: () => apiPost<RunDetail>('/record/stop', {}),
    onSuccess: (st) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.recordStatus });
      const rid = st?.run_id ?? runId;
      if (rid) setPendingReview(rid);
    },
  });
  // "Discard" on the post-stop prompt deletes the run (dir + row); "Keep" just
  // dismisses. Reuses the same DELETE /runs/{id} the Recordings tab uses.
  const discardMutation = useMutation({
    mutationFn: (rid: string) => apiDelete(`/runs/${encodeURIComponent(rid)}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.recordStatus });
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
      setPendingReview(null);
    },
  });
  const busy = startMutation.isPending || stopMutation.isPending;
  // POST /record/start blocks through the recorder's --start-paused arming gate
  // (spawn → subscribe to every target → resume), typically 1–4+ s. The hero
  // shows a distinct amber Starting state for that window so the wait reads as
  // progress, not as an unresponsive button.
  const isStarting = startMutation.isPending;

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
    <>
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-7 gap-y-4 rounded-[18px] border px-6 py-[22px]',
        isActive
          ? 'border-red-200 bg-gradient-to-r from-red-50 via-rose-50 to-white shadow-float'
          : isStarting
            ? 'border-amber-200 bg-gradient-to-r from-amber-50 via-yellow-50 to-white shadow-card'
            : 'border-green-200 bg-gradient-to-r from-green-50 via-emerald-50 to-white shadow-card',
      )}
    >
      <div className="flex items-center gap-4">
        <span
          className={cn(
            'flex h-[46px] w-[46px] items-center justify-center rounded-full',
            isActive ? 'bg-red-50' : isStarting ? 'bg-amber-100' : 'bg-green-100',
          )}
        >
          <span
            className={cn(
              'h-[15px] w-[15px] rounded-full',
              isActive
                ? 'animate-recpulse bg-red-600'
                : isStarting
                  ? 'animate-recpulse bg-amber-500'
                  : 'bg-green-500',
            )}
          />
        </span>
        <div>
          <div className="flex items-center gap-2.5">
            <span
              data-testid="record-state"
              className={cn(
                'text-[12px] font-semibold uppercase tracking-[0.13em]',
                isActive ? 'text-red-600' : isStarting ? 'text-amber-600' : 'text-green-700',
              )}
            >
              {isActive ? 'Recording' : isStarting ? 'Starting…' : 'Idle'}
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
            {/* The recorder only counts messages at finalise; during capture the
                status reports 0, so a dash beats a misleading zero. */}
            <HeroMeta
              label="Messages"
              value={status?.message_count ? status.message_count.toLocaleString() : '—'}
              mono
            />
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

      {isStarting && <StartingNote />}

      {isActive && status?.arming && <ArmingNote arming={status.arming} />}

      {!isActive && status && <IntegrityNote status={status} />}

      {!isActive && !isStarting && startFailure && (
        <div className="w-full" data-testid="start-failed-note">
          <div
            role="alert"
            className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-control border border-red-200 bg-red-50/70 px-3 py-2 text-[12px] text-red-800"
          >
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.09em]">
              Start failed
            </span>
            <span className="font-mono">{startFailure.run_id}</span>
            <span className="font-mono text-[11px] opacity-80">
              {startFailure.error
                ? `${startFailure.error.code}: ${startFailure.error.message}`
                : 'the recorder rejected the start'}
            </span>
          </div>
        </div>
      )}

      {(startMutation.isError || stopMutation.isError) && (
        <div className="w-full">
          <ErrorMessage error={startMutation.error ?? stopMutation.error} />
        </div>
      )}
    </div>

      <Modal
        open={!!pendingReview}
        onClose={() => setPendingReview(null)}
        title="Recording finished"
        footer={
          <>
            <Button
              variant="danger"
              onClick={() => pendingReview && discardMutation.mutate(pendingReview)}
              disabled={discardMutation.isPending}
            >
              {discardMutation.isPending ? 'Discarding…' : 'Discard'}
            </Button>
            <Button
              variant="primary"
              onClick={() => setPendingReview(null)}
              disabled={discardMutation.isPending}
            >
              Keep
            </Button>
          </>
        }
      >
        Keep this take{' '}
        <span className="font-mono text-gray-800">{pendingReview}</span> or discard it?
        Discard permanently deletes it.
        {discardMutation.isError && (
          <div className="mt-2">
            <ErrorMessage error={discardMutation.error} />
          </div>
        )}
      </Modal>
    </>
  );
}

// ---- Alerts surface (MON-C1 counterpart) ------------------------------------
// topic_monitor streams `alert` snapshots over SSE; useEventStream caches them as
// a newest-first rolling buffer (useMonitorRows exposes it as `alerts`). Here we
// collapse that buffer to the CURRENT state per (topic, metric) so the Monitor
// panel can show an active-alert count and a short list without its own polling.

/** One row of the collapsed alert list: the latest state for a (topic, metric). */
interface AlertSummaryRow {
  key: string;
  topic: string;
  metric: string;
  op?: string;
  threshold: number;
  value?: number | null;
  firing: boolean;
  since?: string | null;
}

const ALERT_OP_SYMBOL: Record<string, string> = { lt: '<', le: '≤', gt: '>', ge: '≥' };

function summarizeAlerts(alerts: AlertEvent[]): {
  rows: AlertSummaryRow[];
  activeCount: number;
} {
  // `alerts` is newest-first, so the first event seen for a (topic, metric) is
  // its current state; later (older) events for the same key are ignored.
  const byKey = new Map<string, AlertSummaryRow>();
  for (const a of alerts) {
    const key = `${a.topic}|${a.metric}`;
    if (byKey.has(key)) continue;
    byKey.set(key, {
      key,
      topic: a.topic,
      metric: a.metric,
      op: a.op,
      threshold: a.threshold,
      value: a.value,
      firing: a.state !== 'cleared',
      since: a.since,
    });
  }
  // Firing rows first, then most-recent by start time.
  const rows = [...byKey.values()].sort(
    (x, y) => Number(y.firing) - Number(x.firing) || (y.since ?? '').localeCompare(x.since ?? ''),
  );
  return { rows, activeCount: rows.filter((r) => r.firing).length };
}

function formatAlertTime(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString();
}

// Columns: record checkbox / topic / Hz (actual/expected) / Gap (max
// inter-arrival ms) / bandwidth. True message loss is still NOT shown (ROS 2
// best-effort has no general loss signal; topic_monitor keeps loss_rate=None).
// Instead each row carries a status dot + an "observed shortfall" badge
// (rate_shortfall vs expected_hz, OL-②.1/③.1) with a reason tooltip — an
// honest "is this topic keeping up right now" cue, not a loss claim.
const MON_COLS = 'grid-cols-[28px_1fr_66px_52px_58px]';

function LiveMonitorPanel({
  monitor,
  selected,
  onToggle,
  scopedTopics,
  onScope,
}: {
  monitor: MonitorData;
  selected: Set<string>;
  onToggle: (name: string) => void;
  /** Topics with an open Scope Health panel — highlighted in the Topic column. */
  scopedTopics: Set<string>;
  onScope: (name: string) => void;
}) {
  const { rows, measuredCount, paused, alerts } = monitor;
  const total = rows.length;
  // Robot-edge reachability (orchestrator's monitor bridge): with the robot
  // powered off, say so instead of the misleading empty "no topics yet".
  const monitorBridge = useUiStore((s) => s.monitorBridge);
  // Collapsed alert surface: an active-count badge in the header expands a short
  // list. Default collapsed so it takes no space when nothing has fired.
  const [alertsOpen, setAlertsOpen] = useState(false);
  const alertSummary = useMemo(() => summarizeAlerts(alerts), [alerts]);
  // "Unhealthy" = a measured topic flagged warning/danger/inactive by the
  // backend status (legacy loss_rate>0 kept as a fallback for status-less rows).
  const isUnhealthy = (r: (typeof rows)[number]) =>
    r.measured &&
    (r.status === 'warning' ||
      r.status === 'danger' ||
      r.status === 'inactive' ||
      (r.status == null && r.loss_rate != null && r.loss_rate > 0));
  const unhealthyCount = rows.filter(isUnhealthy).length;
  // `unknown` (no expected_hz to judge against) is NEUTRAL, not healthy — green
  // "Healthy" requires every measured topic to be an affirmative `ok`. With only
  // unknown rows (and nothing unhealthy) the summary stays gray "Monitoring".
  const okCount = rows.filter((r) => r.measured && r.status === 'ok').length;
  const allHealthy = measuredCount > 0 && unhealthyCount === 0 && okCount === measuredCount;
  const headerTone = unhealthyCount > 0 ? 'amber' : allHealthy ? 'green' : 'gray';

  // To-be-recorded (checked) topics float to the top; rows are otherwise already
  // ordered (configured → measured → alphabetical) by useMonitorRows.
  const sorted = useMemo(() => {
    return [...rows].sort(
      (a, b) => Number(selected.has(b.name)) - Number(selected.has(a.name)),
    );
  }, [rows, selected]);

  return (
    <Card className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex items-center gap-2.5 border-b border-gray-100 px-[18px] py-4">
        <SectionLabel>Monitor</SectionLabel>
        <span className="font-mono text-[11px] text-gray-400">{selected.size} to record</span>
        <div className="flex-1" />
        {alertSummary.rows.length > 0 && (
          <button
            type="button"
            aria-label="alerts"
            aria-expanded={alertsOpen}
            onClick={() => setAlertsOpen((v) => !v)}
          >
            <Badge
              tone={alertSummary.activeCount > 0 ? 'red' : 'gray'}
              dot
              className="cursor-pointer"
            >
              {alertSummary.activeCount > 0
                ? `${alertSummary.activeCount} alert${alertSummary.activeCount > 1 ? 's' : ''}`
                : 'alerts'}
            </Badge>
          </button>
        )}
        {paused ? (
          <Badge tone="amber">paused</Badge>
        ) : (
          <Badge tone={headerTone} dot>
            {measuredCount} / {total || 0} {allHealthy ? 'Healthy' : 'Monitoring'}
          </Badge>
        )}
      </div>
      {alertsOpen && alertSummary.rows.length > 0 && (
        <div
          data-testid="alert-list"
          className="border-b border-gray-100 bg-gray-50/60 px-[18px] py-2"
        >
          <div className="max-h-40 overflow-y-auto">
            {alertSummary.rows.slice(0, 12).map((r) => (
              <div
                key={r.key}
                className="flex items-start gap-2 border-b border-gray-100 py-1.5 last:border-b-0"
              >
                <StatusDot tone={r.firing ? 'red' : 'gray'} className="mt-1" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[11.5px] text-gray-700" title={r.topic}>
                    {r.topic}
                  </div>
                  <div className="font-mono text-[10.5px] text-gray-400">
                    {r.metric} {ALERT_OP_SYMBOL[r.op ?? ''] ?? r.op ?? ''} {r.threshold}
                    {r.value != null ? ` · ${r.value}` : ''}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div
                    className={cn(
                      'text-[10px] font-semibold uppercase',
                      r.firing ? 'text-red-600' : 'text-gray-400',
                    )}
                  >
                    {r.firing ? 'firing' : 'cleared'}
                  </div>
                  {formatAlertTime(r.since) && (
                    <div className="font-mono text-[10px] text-gray-400">
                      {formatAlertTime(r.since)}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col px-[18px] pb-4 pt-1.5">
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
          <p className="py-4 text-sm text-gray-500">
            {monitorBridge === 'down'
              ? 'Robot offline — topic discovery and live metrics are unavailable ' +
                '(the monitor on the robot side is unreachable). Recordings / ' +
                'Validation / Datasets still work.'
              : 'No topics on the graph yet.'}
          </p>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            {sorted.map((m) => {
              const tone = rowTone(m);
              const on = selected.has(m.name);
              const loss = formatRateShortfall(m);
              const reason = rowReason(m);
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
                  <span className="flex min-w-0 items-center gap-2" title={reason}>
                    <StatusDot tone={tone} />
                    <button
                      type="button"
                      onClick={() => onScope(m.name)}
                      aria-label={`graph ${m.name} health`}
                      title={reason ? `${m.name}\n${reason}` : m.name}
                      className={cn(
                        'truncate text-left font-mono text-[12.5px] hover:text-teal-700',
                        scopedTopics.has(m.name)
                          ? 'font-semibold text-teal-700'
                          : on
                            ? 'font-semibold text-gray-800'
                            : 'text-gray-700',
                      )}
                    >
                      {m.name}
                    </button>
                    {loss && (
                      <Badge
                        tone={tone}
                        className="shrink-0 px-1.5 py-0 text-[10px] leading-[15px]"
                      >
                        {loss}
                      </Badge>
                    )}
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

// Live robot/config bar: shows the active robot (= the loaded config set) and a
// dropdown to switch it without leaving the Live screen. Reuses the same
// GET /config/options + POST /config/select the Config tab uses; switching a
// robot re-points the whole config, so invalidate runtimeConfig to re-render.
function LiveRobotBar() {
  const queryClient = useQueryClient();
  const optionsQuery = useQuery({
    queryKey: queryKeys.configOptions,
    queryFn: ({ signal }) => apiGet<ConfigOptions>('/config/options', { signal }),
  });
  const selectMutation = useMutation({
    mutationFn: (id: string) => apiPost<ConfigOptions>('/config/select', { category: 'robot', id }),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.configOptions, data);
      // Robot switch changes default_topics + stream panes + the editable
      // recording file — refresh the runtime config so the whole Live view follows.
      void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeConfig });
    },
  });
  const data = optionsQuery.data;
  const recordingOption = data?.aspects?.recording?.active;

  return (
    <div className="flex flex-wrap items-center gap-2.5" data-testid="live-robot-bar">
      <SectionLabel>Robot</SectionLabel>
      {optionsQuery.isError ? (
        <span className="text-sm text-red-600">config unavailable</span>
      ) : !data?.robots ? (
        <span className="text-sm text-gray-500">Loading…</span>
      ) : (
        <>
          <select
            aria-label="active robot"
            value={data.active_robot}
            disabled={selectMutation.isPending}
            onChange={(e) => selectMutation.mutate(e.target.value)}
            className="rounded-control border border-gray-200 px-2.5 py-1.5 font-mono text-sm focus:border-teal-500 focus:outline-none disabled:opacity-50"
          >
            {data.robots.map((r) => (
              <option key={r.id} value={r.id}>
                {r.id}
                {r.local ? ' (local)' : ''}
              </option>
            ))}
          </select>
          <span className="font-mono text-[11px] text-gray-400">
            config: {data.active_robot}
            {recordingOption ? ` · ${recordingOption}` : ''}
          </span>
          {selectMutation.isPending && (
            <span className="text-[11px] text-gray-400">switching…</span>
          )}
          {selectMutation.isError && (
            <span className="text-[11px] text-red-600">switch failed</span>
          )}
        </>
      )}
    </div>
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
  // Record-topic selection lives in the UI store so a tab switch (which unmounts
  // the Live tab) doesn't silently revert a customized set back to the configured
  // defaults — that would start the next recording with an unintended topic set.
  // Seeded once from the configured topics as discovery first arrives.
  const selected = useUiStore((s) => s.recordSelected);
  const customized = useUiStore((s) => s.recordCustomized);
  const seedRecordTopics = useUiStore((s) => s.seedRecordTopics);
  const toggle = useUiStore((s) => s.toggleRecordTopic);

  // Key the seed on the active robot's configured topics (stable across
  // discovery refreshes, changes on a robot switch) — mirrors the stream panes'
  // `streamPanesSeededKey`. A robot switch re-seeds and resets any stale
  // customized selection so the previous robot's topics can't reach the next
  // Start.
  const seedKey = useMemo(
    () => JSON.stringify(config.defaults.default_topics ?? []),
    [config],
  );
  useEffect(() => {
    if (monitor.rows.length === 0) return;
    seedRecordTopics(
      monitor.rows.filter((r) => r.configured).map((r) => r.name),
      seedKey,
    );
  }, [monitor.rows, seedRecordTopics, seedKey]);

  const selection: RecordSelection = useMemo(() => {
    if (customized) {
      return { topics: [...selected], count: selected.size, customized: true };
    }
    if (defaultTopics.length > 0) {
      return { topics: defaultTopics, count: defaultTopics.length, customized: false };
    }
    return { topics: 'all', count: 0, customized: false };
  }, [customized, selected, defaultTopics]);

  // Scope band (OL-③.2 successor): the operator clicks a topic in the Monitor
  // panel to add a Health panel for it (or just open the band if one already
  // plots that topic). History accumulates from the same SSE metrics stream
  // the panel uses (no extra subscription, no payload decode); it keeps
  // accumulating whether or not the band is open (a second call would restart
  // the buffer, so the band never calls this itself).
  const metricHistory = useMetricHistory(config, false);
  const recMarkers = useRecordMarkers();
  const addHealthPanel = useUiStore((s) => s.addHealthPanel);
  const scopePanels = useUiStore((s) => s.scopePanels);
  // Topics with an open Health panel, for the Monitor row highlight.
  const scopedTopics = useMemo(() => {
    const set = new Set<string>();
    for (const p of scopePanels) {
      if (p.kind === 'health') for (const t of p.topics) set.add(t);
    }
    return set;
  }, [scopePanels]);
  const monitorTopicNames = useMemo(() => monitor.rows.map((r) => r.name), [monitor.rows]);

  // No-page-scroll layout (lg+): bound the Live view to the viewport so the
  // stream grid + monitor + Scope band fit without the page scrolling.
  // RecordHero/robot bar are natural height; the [stream | monitor] row
  // consumes the rest (flex-1) minus the Scope band's own fixed height (see
  // ScopeBand.tsx), the stream fills it (fit) and the monitor scrolls
  // internally. Below lg it flows naturally.
  return (
    <div className="flex flex-col gap-3 lg:h-full lg:min-h-0 lg:overflow-hidden">
      <LiveRobotBar />
      <RecordHero selection={selection} />
      <div className="grid grid-cols-1 gap-[18px] lg:min-h-0 lg:flex-1 lg:grid-cols-[1.62fr_1fr]">
        <div className="flex min-h-0 min-w-0 flex-col">
          <StreamTab config={config} fit />
        </div>
        <LiveMonitorPanel
          monitor={monitor}
          selected={selected}
          onToggle={toggle}
          scopedTopics={scopedTopics}
          onScope={addHealthPanel}
        />
      </div>
      <ScopeBand history={metricHistory.history} topics={monitorTopicNames} markers={recMarkers} />
    </div>
  );
}
