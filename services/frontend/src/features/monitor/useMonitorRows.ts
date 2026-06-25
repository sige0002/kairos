// Shared monitor data: merges ROS 2 graph discovery (GET /api/v1/topics) with
// the live SSE `metrics` snapshot into per-topic health rows. Extracted from
// MonitorTab so both the standalone Monitor table and the fused Live tab's
// compact Monitor panel render the same numbers. Pure data — no JSX.

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type {
  AlertEvent,
  MetricsSnapshot,
  TopicInfo,
  TopicMetric,
} from '../../api/types';
import type { RuntimeConfig } from '../../config';
import { matchesTopic } from '../record/topics';
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
  return m.expected_hz ? `${hz} / ${m.expected_hz}` : hz;
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

export function formatBandwidth(bps?: number | null): string {
  if (bps === undefined || bps === null) return '—';
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} Mbps`;
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(1)} kbps`;
  return `${bps.toFixed(0)} bps`;
}

/** Per-row health colour: unmeasured = gray, lossy = amber, otherwise green. */
export function rowTone(m: { measured: boolean; loss_rate?: number | null }): Tone {
  if (!m.measured) return 'gray';
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
      apiGet<TopicInfo[] | { topics?: TopicInfo[]; items?: TopicInfo[] }>('/topics', {
        signal,
      }),
    refetchInterval: 5000,
  });

  const metrics: TopicMetric[] = metricsQuery.data?.topics ?? [];
  const paused = metricsQuery.data?.paused ?? false;
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
    // Configured topics first, then measured, then alphabetical.
    return [...byName.values()].sort((a, b) => {
      if (a.configured !== b.configured) return a.configured ? -1 : 1;
      if (a.measured !== b.measured) return a.measured ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [discovered, metrics, resolve]);

  return {
    rows,
    measuredCount: rows.filter((r) => r.measured).length,
    paused,
    alerts: alertsQuery.data ?? [],
    isDiscovering: topicsQuery.isPending,
  };
}
