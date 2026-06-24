// Monitor tab: a live "what's on the graph" view (rosbag-view style). It always
// lists EVERY topic on the ROS 2 graph (GET /api/v1/topics discovery) and
// overlays live health metrics from the SSE `metrics` snapshot when the monitor
// is measuring that topic. Field names mirror the backend `TopicMetrics` model
// (name / hz / bandwidth_bps / gap_max_ms / stamp_delay_ms / loss_rate); expected
// Hz is resolved from the RECORDING_CONFIG `expected_hz` patterns. Topics in
// `default_topics` are flagged "configured". Alerts come from the SSE `alert` key.

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
import { useUiStore } from '../../store/uiStore';

interface MonitorRow extends Partial<TopicMetric> {
  name: string;
  publisher_count?: number;
  expected_hz?: number;
  configured: boolean;
  /** Present on the graph right now (discovery). */
  live: boolean;
  /** The monitor is measuring this topic (has a metrics row). */
  measured: boolean;
}

function formatHz(m: MonitorRow): string {
  if (m.hz === undefined || m.hz === null) return m.expected_hz ? `— / ${m.expected_hz}` : '—';
  const hz = m.hz.toFixed(1);
  return m.expected_hz ? `${hz} / ${m.expected_hz}` : hz;
}

// Late: prefer the header.stamp delay (ms); fall back to the receive-time
// late-arrival ratio as a percentage when stamp quality is unavailable.
function formatLate(m: MonitorRow): string {
  if (m.stamp_delay_ms !== undefined && m.stamp_delay_ms !== null) {
    return `${m.stamp_delay_ms.toFixed(0)} ms`;
  }
  if (m.inter_arrival_late_ratio !== undefined && m.inter_arrival_late_ratio !== null) {
    return `${(m.inter_arrival_late_ratio * 100).toFixed(0)}%`;
  }
  return '—';
}

function formatGap(m: MonitorRow): string {
  if (m.gap_max_ms === undefined || m.gap_max_ms === null) return '—';
  const max = `${m.gap_max_ms.toFixed(0)} ms`;
  return m.gap_exceed_count ? `${max} (${m.gap_exceed_count})` : max;
}

function formatLoss(m: MonitorRow): string {
  if (m.loss_rate === undefined || m.loss_rate === null) return '—';
  return `${(m.loss_rate * 100).toFixed(1)}%`;
}

function formatBandwidth(bps?: number | null): string {
  if (bps === undefined || bps === null) return '—';
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} Mbps`;
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(1)} kbps`;
  return `${bps.toFixed(0)} bps`;
}

function asTopicList(data: TopicInfo[] | { topics?: TopicInfo[]; items?: TopicInfo[] }) {
  if (Array.isArray(data)) return data;
  return data.topics ?? data.items ?? [];
}

function SseBadge() {
  const status = useUiStore((s) => s.sseStatus);
  const color =
    status === 'open'
      ? 'bg-green-100 text-green-800'
      : status === 'reconnecting' || status === 'connecting'
        ? 'bg-amber-100 text-amber-800'
        : 'bg-gray-200 text-gray-700';
  return (
    <span className={`rounded px-2 py-0.5 text-xs ${color}`} data-testid="sse-status">
      live: {status}
    </span>
  );
}

export function MonitorTab({ config }: { config?: RuntimeConfig }) {
  const defaultTopics = useMemo(
    () => config?.defaults.default_topics ?? [],
    [config],
  );
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

  // SSE-fed cache: written by useEventStream, never fetched here. The queryFn is
  // a guard that never runs (enabled: false) and only documents intent.
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

  // Merge discovery + metrics by topic name (union). Discovery gives type /
  // publisher count / existence; metrics gives the live rates.
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

  const measuredCount = rows.filter((r) => r.measured).length;
  const alerts = alertsQuery.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">
          Topic Health{' '}
          <span className="text-sm font-normal text-gray-500">
            ({rows.length} on graph · {measuredCount} measured)
          </span>
          {paused && (
            <span className="ml-2 rounded bg-amber-100 px-1.5 text-xs text-amber-800">
              paused
            </span>
          )}
        </h2>
        <SseBadge />
      </div>

      <div className="overflow-x-auto rounded border">
        <table className="w-full text-sm" aria-label="topic health">
          <thead className="bg-gray-50 text-left">
            <tr>
              <th className="px-3 py-2">Topic</th>
              <th className="px-3 py-2">Pub</th>
              <th className="px-3 py-2">Hz</th>
              <th className="px-3 py-2">Late</th>
              <th className="px-3 py-2">Gap</th>
              <th className="px-3 py-2">Loss</th>
              <th className="px-3 py-2">Bandwidth</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className="px-3 py-4 text-gray-500" colSpan={7}>
                  {topicsQuery.isPending
                    ? 'Discovering topics…'
                    : 'No topics on the graph yet. Start the robot or replay a bag.'}
                </td>
              </tr>
            ) : (
              rows.map((m) => (
                <tr key={m.name} className="border-t">
                  <td className="px-3 py-2">
                    <span className="font-mono">{m.name}</span>
                    {m.configured && (
                      <span className="ml-2 rounded bg-blue-100 px-1.5 text-xs text-blue-800">
                        configured
                      </span>
                    )}
                    {!m.measured && m.live && (
                      <span className="ml-2 rounded bg-gray-100 px-1.5 text-xs text-gray-500">
                        not measured
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">{m.publisher_count ?? '—'}</td>
                  <td className="px-3 py-2">{formatHz(m)}</td>
                  <td className="px-3 py-2">{formatLate(m)}</td>
                  <td className="px-3 py-2">{formatGap(m)}</td>
                  <td className="px-3 py-2">{formatLoss(m)}</td>
                  <td className="px-3 py-2">{formatBandwidth(m.bandwidth_bps)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <section aria-label="alerts">
        <h2 className="mb-2 font-semibold">Alerts</h2>
        {alerts.length === 0 ? (
          <p className="text-sm text-gray-500">No alerts.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {alerts.map((a, i) => (
              <li
                key={`${a.topic}-${a.metric}-${a.since ?? i}`}
                className={`rounded px-3 py-2 text-sm ${
                  a.state === 'cleared'
                    ? 'bg-gray-50 text-gray-700'
                    : 'bg-red-50 text-red-800'
                }`}
              >
                <span className="font-mono">{a.topic}</span> {a.metric} {a.op}{' '}
                {a.threshold}
                {a.value != null ? ` (is ${a.value})` : ''} — {a.state ?? 'firing'}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
