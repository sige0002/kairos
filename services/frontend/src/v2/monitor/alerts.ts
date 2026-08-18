// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Pure mapping from the REAL alert buffer (AlertEvent[], accumulated in the
// TanStack Query cache by useEventStream — a rolling max-100 of the monitor's
// `alert` SSE snapshots) to the Monitor Events card's display rows.
//
// The monitor re-sends every incident's CURRENT state each tick (firing with the
// live value; cleared for a retention window) so the transition is delivered
// reliably over the lossy periodic SSE path. We collapse that here: ONE row per
// (topic, metric) incident, the newest event winning, so a sustained breach is a
// single row that flips firing→cleared rather than a flood of duplicates (I-6).
// Kept separate from the card so the formatting/collapse is unit-testable.

import type { AlertEvent, AlertMetric } from '../../api/types';

export type AlertTone = 'red' | 'gray';

export interface AlertRow {
  /** Incident identity — one row per (topic, metric). */
  key: string;
  /** Full topic path (for the Events sub-view's substring filter). */
  topic: string;
  tone: AlertTone;
  state: 'firing' | 'cleared';
  /** e.g. `joint_states Hz < 45` */
  title: string;
  /** e.g. `now 42.1` (the live breaching value) while firing; '' when cleared. */
  detail: string;
  /** Local HH:MM:SS: firing = since it started, cleared = when it cleared. */
  time: string;
  /** Distinct firing episodes seen in the buffer (>=1 once it has fired). */
  refires: number;
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
  return d.toLocaleTimeString('en-GB', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Incident identity: one row per (topic, metric), independent of state/since. */
function incidentKey(a: AlertEvent): string {
  return `${a.topic}|${a.metric}`;
}

/** Format ONE event as a row (the collapse in toAlertRows picks which event). */
export function formatAlert(a: AlertEvent): AlertRow {
  const state: 'firing' | 'cleared' = a.state === 'cleared' ? 'cleared' : 'firing';
  const metric = METRIC_LABEL[a.metric] ?? a.metric;
  const op = a.op ? OP_SYMBOL[a.op] : '';
  const title = [shortTopic(a.topic), metric, op, a.threshold].filter((p) => p !== '').join(' ');
  // Only a firing row carries the live value; a cleared row is just the recovery.
  const detail = state === 'firing' && a.value != null ? `now ${a.value}` : '';
  return {
    key: incidentKey(a),
    topic: a.topic,
    // A cleared alert is a recovery (muted); a firing one is an active breach.
    tone: state === 'cleared' ? 'gray' : 'red',
    state,
    title,
    detail,
    time: formatTime(a.since),
    refires: 1,
  };
}

/**
 * Collapse the (newest-first) buffer into one row per incident: the newest event
 * for each (topic, metric) defines the row's current state, and distinct firing
 * `since` values count the refires. Firing rows sort above cleared ones (active
 * breaches on top, recoveries muted below), each keeping recency order.
 */
export function toAlertRows(alerts: AlertEvent[], cap: number): AlertRow[] {
  const order: string[] = []; // incident keys in newest-first discovery order
  const latest = new Map<string, AlertEvent>();
  const episodes = new Map<string, Set<string>>(); // firing `since` values seen
  for (const a of alerts) {
    const key = incidentKey(a);
    if (!latest.has(key)) {
      latest.set(key, a);
      order.push(key);
    }
    if (a.state !== 'cleared') {
      const set = episodes.get(key) ?? new Set<string>();
      set.add(a.since ?? ''); // stable within one episode, changes on refire
      episodes.set(key, set);
    }
  }
  const rows = order.map((key) => ({
    ...formatAlert(latest.get(key)!),
    refires: episodes.get(key)?.size ?? 0,
  }));
  // Stable sort (V8): firing (0) before cleared (1), recency preserved within each.
  rows.sort((a, b) => Number(a.state === 'cleared') - Number(b.state === 'cleared'));
  return rows.slice(0, cap);
}

/** Distinct incidents in the buffer (for the honest "N alerts" header count). */
export function incidentCount(alerts: AlertEvent[]): number {
  const keys = new Set<string>();
  for (const a of alerts) keys.add(incidentKey(a));
  return keys.size;
}
