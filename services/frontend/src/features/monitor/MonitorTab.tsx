// Monitor tab: live Topic Health table (Hz / Late / Gap / Loss / bandwidth)
// plus an alert feed. Primary source is the SSE `metrics` snapshot written to
// the metrics query key by useEventStream. When no SSE metrics have arrived
// yet, we fall back to REST GET /api/v1/topics (discovery) so the table still
// lists known topics. Alerts come from the SSE `alert` query key.

import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type {
  AlertEvent,
  MetricsSnapshot,
  TopicInfo,
  TopicMetric,
} from '../../api/types';
import { useUiStore } from '../../store/uiStore';

function formatHz(m: TopicMetric): string {
  if (m.hz === undefined) return '—';
  const hz = m.hz.toFixed(1);
  return m.expected_hz ? `${hz} / ${m.expected_hz}` : hz;
}

function formatBandwidth(bps?: number): string {
  if (bps === undefined) return '—';
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} Mbps`;
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(1)} kbps`;
  return `${bps} bps`;
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

export function MonitorTab() {
  // SSE-fed caches: written by useEventStream, never fetched here. The queryFn
  // is a guard that never runs (enabled: false) and only documents intent.
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

  // REST fallback: topic discovery when no live metrics are present yet.
  const haveMetrics = (metricsQuery.data?.topics?.length ?? 0) > 0;
  const topicsQuery = useQuery({
    queryKey: queryKeys.topics,
    queryFn: ({ signal }) =>
      apiGet<TopicInfo[] | { items: TopicInfo[] }>('/topics', { signal }),
    enabled: !haveMetrics,
    refetchInterval: haveMetrics ? false : 5000,
  });

  const metricsRows: TopicMetric[] = metricsQuery.data?.topics ?? [];
  const fallbackTopics: TopicInfo[] = Array.isArray(topicsQuery.data)
    ? topicsQuery.data
    : (topicsQuery.data?.items ?? []);

  const rows: TopicMetric[] = haveMetrics
    ? metricsRows
    : fallbackTopics.map((t) => ({ topic: t.name }));

  const alerts = alertsQuery.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Topic Health</h2>
        <SseBadge />
      </div>

      <div className="overflow-x-auto rounded border">
        <table className="w-full text-sm" aria-label="topic health">
          <thead className="bg-gray-50 text-left">
            <tr>
              <th className="px-3 py-2">Topic</th>
              <th className="px-3 py-2">Hz</th>
              <th className="px-3 py-2">Late (ms)</th>
              <th className="px-3 py-2">Gap</th>
              <th className="px-3 py-2">Loss</th>
              <th className="px-3 py-2">Bandwidth</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className="px-3 py-4 text-gray-500" colSpan={6}>
                  {topicsQuery.isPending && !haveMetrics
                    ? 'Loading topics…'
                    : 'No topics yet.'}
                </td>
              </tr>
            ) : (
              rows.map((m) => (
                <tr key={m.topic} className="border-t">
                  <td className="px-3 py-2 font-mono">{m.topic}</td>
                  <td className="px-3 py-2">{formatHz(m)}</td>
                  <td className="px-3 py-2">{m.late_ms ?? '—'}</td>
                  <td className="px-3 py-2">{m.gap ?? '—'}</td>
                  <td className="px-3 py-2">{m.loss ?? '—'}</td>
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
                key={`${a.topic}-${a.metric}-${a.ts ?? i}`}
                className={`rounded px-3 py-2 text-sm ${
                  a.level === 'critical'
                    ? 'bg-red-50 text-red-800'
                    : a.level === 'warn'
                      ? 'bg-amber-50 text-amber-800'
                      : 'bg-gray-50 text-gray-700'
                }`}
              >
                <span className="font-mono">{a.topic}</span> {a.metric} {a.value} (
                threshold {a.threshold}) — {a.level}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
