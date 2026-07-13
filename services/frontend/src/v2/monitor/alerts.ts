// Pure mapping from the REAL alert buffer (AlertEvent[], accumulated in the
// TanStack Query cache by useEventStream — a rolling max-100 of the monitor's
// `alert` SSE snapshots) to the Monitor Events card's display rows. Kept
// separate from the card so the firing/cleared + op/threshold/value formatting
// is unit-testable without rendering.

import type { AlertEvent, AlertMetric } from '../../api/types';

export type AlertTone = 'red' | 'gray';

export interface AlertRow {
  /** Stable-ish key for React (topic+metric+state+since). */
  key: string;
  tone: AlertTone;
  state: 'firing' | 'cleared';
  /** e.g. `joint_states Hz < 45` */
  title: string;
  /** e.g. `now 42.1` (the breaching value), or '' when none reported. */
  detail: string;
  /** Local HH:MM:SS from `since`, or '—' when the backend sent no timestamp. */
  time: string;
}

const METRIC_LABEL: Record<AlertMetric, string> = {
  hz: 'Hz',
  bandwidth: 'bandwidth',
  gap: 'gap',
  late: 'latency',
  loss: 'loss',
};

const OP_SYMBOL: Record<NonNullable<AlertEvent['op']>, string> = {
  lt: '<',
  gt: '>',
  le: '≤',
  ge: '≥',
};

function shortTopic(topic: string): string {
  return topic.split('/').filter(Boolean).at(-1) ?? topic;
}

function formatTime(since: string | null | undefined): string {
  if (!since) return '—';
  const d = new Date(since);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function formatAlert(a: AlertEvent): AlertRow {
  const state: 'firing' | 'cleared' = a.state === 'cleared' ? 'cleared' : 'firing';
  const metric = METRIC_LABEL[a.metric] ?? a.metric;
  const op = a.op ? OP_SYMBOL[a.op] : '';
  const title = [shortTopic(a.topic), metric, op, a.threshold].filter((p) => p !== '').join(' ');
  const detail = a.value != null ? `now ${a.value}` : '';
  return {
    key: `${a.topic}|${a.metric}|${state}|${a.since ?? ''}`,
    // A cleared alert is a recovery (muted); a firing one is an active breach.
    tone: state === 'cleared' ? 'gray' : 'red',
    state,
    title,
    detail,
    time: formatTime(a.since),
  };
}

/** Map + cap the buffer for display (buffer is already newest-first). */
export function toAlertRows(alerts: AlertEvent[], cap: number): AlertRow[] {
  return alerts.slice(0, cap).map(formatAlert);
}
