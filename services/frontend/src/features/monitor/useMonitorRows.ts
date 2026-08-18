// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Shared monitor data: merges ROS 2 graph discovery (GET /api/v1/topics) with
// the live SSE `metrics` snapshot into per-topic health rows. Extracted from
// MonitorTab so both the standalone Monitor table and the fused Live tab's
// compact Monitor panel render the same numbers. Pure data — no JSX.

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getTopics } from '../../api/system';
import { queryKeys } from '../../api/queryKeys';
import { TOPIC_DISCOVERY_POLL_MS } from '../../v2/pollingPolicy';
import type {
  AlertEvent,
  MetricsSnapshot,
  MonitorSelfLoad,
  TopicInfo,
  TopicMetric,
  TopicStatus,
} from '../../api/types';
import type { RuntimeConfig } from '../../config';
import { matchesTopic } from '../record/topics';
import { useUiStore } from '../../store/uiStore';
import type { Tone } from '../../components/ui';

export interface MonitorRow extends Partial<TopicMetric> {
  name: string;
  publisher_count?: number;
  expected_hz?: number;
  configured: boolean;
  /** Present on the graph right now (discovery). */
  live: boolean;
  /** The monitor is measuring this topic (has a metrics row). */
  measured: boolean;
}

export function formatHz(m: MonitorRow): string {
  if (m.hz === undefined || m.hz === null) return m.expected_hz ? `— / ${m.expected_hz}` : '—';
  const hz = m.hz.toFixed(1);
  if (m.expected_hz) return `${hz} / ${m.expected_hz}`;
  // No static expected_hz: show the learned baseline (OL-②.3) as the reference,
  // prefixed `~` so it never reads as a configured rate.
  if (m.baseline_hz != null) return `${hz} / ~${m.baseline_hz.toFixed(1)}`;
  return hz;
}

// Learned-baseline label for a topic with no static expected_hz (OL-②.3). Null
// when a static rate is configured (it wins) or no baseline state is reported.
export function formatBaseline(m: MonitorRow): string | null {
  if (m.expected_hz) return null;
  switch (m.baseline_state) {
    case 'learning':
      return 'learning…';
    case 'stable':
      return m.baseline_hz != null ? `~${m.baseline_hz.toFixed(1)} Hz` : 'baseline';
    case 'unstable':
      return m.baseline_hz != null
        ? `~${m.baseline_hz.toFixed(1)} Hz (unstable)`
        : 'unstable';
    default:
      return null;
  }
}

// Late: prefer the header.stamp delay (ms); fall back to the receive-time
// late-arrival ratio as a percentage when stamp quality is unavailable.
export function formatLate(m: MonitorRow): string {
  if (m.stamp_delay_ms !== undefined && m.stamp_delay_ms !== null) {
    return `${m.stamp_delay_ms.toFixed(0)} ms`;
  }
  if (m.inter_arrival_late_ratio !== undefined && m.inter_arrival_late_ratio !== null) {
    return `${(m.inter_arrival_late_ratio * 100).toFixed(0)}%`;
  }
  return '—';
}

export function formatGap(m: MonitorRow): string {
  if (m.gap_max_ms === undefined || m.gap_max_ms === null) return '—';
  const max = `${m.gap_max_ms.toFixed(0)} ms`;
  return m.gap_exceed_count ? `${max} (${m.gap_exceed_count})` : max;
}

export function formatLoss(m: MonitorRow): string {
  if (m.loss_rate === undefined || m.loss_rate === null) return '—';
  return `${(m.loss_rate * 100).toFixed(1)}%`;
}

// Compact observed-shortfall badge text, or null when nothing is worth flagging.
// This is observed shortfall vs expected_hz (OL-②.1) — NOT true loss. Only shown
// for statuses the backend actually flags (inactive/warning/danger), so an "ok"
// topic with a sub-threshold shortfall does not get a misleading green badge.
export function formatRateShortfall(m: MonitorRow): string | null {
  if (m.status === 'inactive') return 'silent';
  if (m.status !== 'warning' && m.status !== 'danger') return null;
  const lr = m.rate_shortfall;
  if (lr === undefined || lr === null || lr <= 0) return null;
  return lr >= 0.1 ? `${Math.round(lr * 100)}%` : `${(lr * 100).toFixed(1)}%`;
}

// The tooltip line for a row's health (baseline state, then backend reason,
// then late reason). During learning/instability the baseline state is the most
// honest explanation (OL-②.3); otherwise the backend status reason wins.
export function rowReason(m: MonitorRow): string | undefined {
  if (m.baseline_state === 'learning') return 'learning baseline…';
  if (m.baseline_state === 'unstable') return 'baseline unstable (using last good)';
  return m.status_reason ?? m.reason ?? undefined;
}

/** Tone for the monitor's own self-load health (OL-②.4). */
export function selfLoadTone(s?: MonitorSelfLoad | null): Tone {
  if (!s) return 'gray';
  if (s.status === 'danger') return 'red';
  if (s.status === 'warning') return 'amber';
  return 'green';
}

// One-line summary of the monitor's own processing health (OL-②.4): mean
// callback latency and data-freshness age. Null when self-load metrics are off
// (the snapshot carries no `self_load`) or there is nothing to report yet.
export function formatSelfLoad(s?: MonitorSelfLoad | null): string | null {
  if (!s) return null;
  const parts: string[] = [];
  if (s.callback_lag_ms != null) parts.push(`${s.callback_lag_ms.toFixed(1)} ms cb`);
  if (s.snapshot_age_s != null) parts.push(`${s.snapshot_age_s.toFixed(1)} s age`);
  return parts.length ? parts.join(' · ') : null;
}

const STATUS_TONE: Record<TopicStatus, Tone> = {
  ok: 'green',
  warning: 'amber',
  danger: 'red',
  inactive: 'red',
  unknown: 'gray',
};

/** Tone for a backend per-topic status (OL-②.2). */
export function statusTone(status?: TopicStatus | null): Tone {
  return status ? STATUS_TONE[status] : 'gray';
}

export function formatBandwidth(bps?: number | null): string {
  if (bps === undefined || bps === null) return '—';
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} Mbps`;
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(1)} kbps`;
  return `${bps.toFixed(0)} bps`;
}

/**
 * Per-row health colour. Prefers the backend per-topic `status` (OL-②.2); for
 * unmeasured rows (discovery only, no metrics) stays gray. The legacy
 * loss_rate>0 branch is kept as a fallback for snapshots without `status`.
 */
export function rowTone(m: {
  measured: boolean;
  status?: TopicStatus | null;
  loss_rate?: number | null;
}): Tone {
  if (!m.measured) return 'gray';
  if (m.status) return statusTone(m.status);
  if (m.loss_rate != null && m.loss_rate > 0) return 'amber';
  return 'green';
}

function asTopicList(data: TopicInfo[] | { topics?: TopicInfo[]; items?: TopicInfo[] }) {
  if (Array.isArray(data)) return data;
  return data.topics ?? data.items ?? [];
}

export interface MonitorData {
  rows: MonitorRow[];
  measuredCount: number;
  paused: boolean;
  alerts: AlertEvent[];
  isDiscovering: boolean;
  /** The monitor's own processing health (OL-②.4); null when self-load is off. */
  selfLoad: MonitorSelfLoad | null;
  /** Readings the SSE ingest could not identify and dropped (E-23). Surfaced
   *  so a row that vanished does not vanish silently. */
  malformedDropped: number;
  /** True while live metrics CANNOT be current (SSE not open, or the monitor
   *  bridge down): measured values are withheld from the rows rather than
   *  frozen at the last snapshot (S3-6). Discovery columns still fill. */
  metricsStale: boolean;
}

/**
 * Configured topics first, then measured, then alphabetical.
 *
 * `String(...)` around the name is E-23's SECOND line of defence, not its
 * first: the ingest drops rows it cannot identify (sse/useEventStream
 * applyMetrics), so a non-string name should never arrive here. It is here
 * because this file has more than one possible writer, and because of what a
 * throw in THIS comparator costs — `localeCompare` on a non-string threw for
 * the whole list, the throw escaped to the root error boundary, and the entire
 * console went down, tab bar included, for an operator who was on another tab.
 * A sort is not worth that, so it does not assume its input.
 */
export function sortRowsForDisplay<T extends { name: string; configured?: boolean; measured?: boolean }>(
  rows: T[],
): T[] {
  return [...rows].sort((a, b) => {
    if (a.configured !== b.configured) return a.configured ? -1 : 1;
    if (a.measured !== b.measured) return a.measured ? -1 : 1;
    return String(a.name).localeCompare(String(b.name));
  });
}

export function useMonitorRows(config?: RuntimeConfig): MonitorData {
  const defaultTopics = useMemo(() => config?.defaults.default_topics ?? [], [config]);
  const expectedHzPatterns = useMemo(
    () => Object.entries(config?.defaults.expected_hz ?? {}),
    [config],
  );
  const resolve = useMemo(() => {
    const isConfigured = (name: string) =>
      defaultTopics.some((p) => matchesTopic(p, name));
    // First matching expected_hz pattern wins (mirrors the backend).
    const expectedHz = (name: string): number | undefined => {
      const hit = expectedHzPatterns.find(([pat]) => matchesTopic(pat, name));
      return hit ? hit[1] : undefined;
    };
    return { isConfigured, expectedHz };
  }, [defaultTopics, expectedHzPatterns]);

  // SSE-fed caches: written by useEventStream, never fetched here.
  const sseOnly = () => {
    throw new Error('SSE-only cache: written by useEventStream');
  };
  const metricsQuery = useQuery<MetricsSnapshot>({
    queryKey: queryKeys.metrics,
    queryFn: sseOnly,
    enabled: false,
  });
  const alertsQuery = useQuery<AlertEvent[]>({
    queryKey: queryKeys.alerts,
    queryFn: sseOnly,
    enabled: false,
  });

  // Always poll graph discovery so every topic is listed, not just measured ones.
  const topicsQuery = useQuery({
    queryKey: queryKeys.topics,
    queryFn: ({ signal }) =>
      getTopics({ signal }),
    refetchInterval: TOPIC_DISCOVERY_POLL_MS,
  });

  // Freshness gate (S3-6). The metrics cache is only ever WRITTEN by the SSE
  // stream, so once that stream is down (or the orchestrator says its link to
  // the monitor is), the cache is a snapshot of the moment things died — and
  // this table kept rendering those Hz/bandwidth numbers as current while the
  // header said "reconnecting…". Collect's system card already gates on the
  // bridge (useSystemRows); this is the same rule for the table: a reading we
  // cannot take is shown as no reading, not as the last one that came back.
  const sseStatus = useUiStore((s) => s.sseStatus);
  const monitorBridge = useUiStore((s) => s.monitorBridge);
  const metricsFresh = sseStatus === 'open' && monitorBridge !== 'down';

  const metrics: TopicMetric[] = metricsFresh ? (metricsQuery.data?.topics ?? []) : [];
  const paused = metricsFresh ? (metricsQuery.data?.paused ?? false) : false;
  const selfLoad = metricsFresh ? (metricsQuery.data?.self_load ?? null) : null;
  const malformedDropped = metricsFresh
    ? (metricsQuery.data?.malformed_dropped ?? 0)
    : 0;
  const discovered: TopicInfo[] = asTopicList(topicsQuery.data ?? []);

  const rows: MonitorRow[] = useMemo(() => {
    const byName = new Map<string, MonitorRow>();
    for (const t of discovered) {
      byName.set(t.name, {
        name: t.name,
        type: t.type,
        publisher_count: t.publisher_count,
        expected_hz: resolve.expectedHz(t.name),
        configured: resolve.isConfigured(t.name),
        live: true,
        measured: false,
      });
    }
    for (const m of metrics) {
      const existing = byName.get(m.name);
      if (existing) {
        Object.assign(existing, m, { measured: true });
      } else {
        byName.set(m.name, {
          ...m,
          expected_hz: resolve.expectedHz(m.name),
          configured: resolve.isConfigured(m.name),
          live: false,
          measured: true,
        });
      }
    }
    return sortRowsForDisplay([...byName.values()]);
  }, [discovered, metrics, resolve]);

  return {
    rows,
    measuredCount: rows.filter((r) => r.measured).length,
    paused,
    malformedDropped,
    alerts: alertsQuery.data ?? [],
    isDiscovering: topicsQuery.isPending,
    selfLoad,
    metricsStale: !metricsFresh,
  };
}
