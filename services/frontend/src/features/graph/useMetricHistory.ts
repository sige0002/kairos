// Rolling client-side metric history for the Graph tab. topic_monitor streams
// point-in-time snapshots over SSE (`metrics`); we accumulate a per-topic
// history of every graphable field into ONE shared buffer so any number of
// charts can read from it without each re-accumulating.
//
// Robot-independent by construction: the topic set comes from whatever is
// actually flowing in the snapshot, never from hardcoded names. `expected_hz`
// only feeds the derived `rate` field and is optional — every other field works
// for any topic on any robot.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../../api/queryKeys';
import type { MetricsSnapshot, TopicStatus } from '../../api/types';
import type { RuntimeConfig } from '../../config';
import { matchesTopic } from '../record/topics';

/** One accumulated sample carrying every graphable field for a topic. */
export interface MetricSample {
  t: number; // wall-clock ms
  hz: number | null;
  bw: number | null; // MB/s
  gap: number | null; // ms (largest inter-arrival gap in the window)
  lat: number | null; // ms (header.stamp delay — unmeasured by the raw monitor)
  loss: number | null; // % true loss (not computable in ROS 2 — always null)
  rate: number | null; // % of expected_hz (only when expected_hz is configured)
  // Observed shortfall vs expected_hz (OL-②.1) — NOT true loss. For the live
  // health graph (OL-③.2): plot against the 2%/5% status thresholds.
  shortfall: number | null; // % (rate_shortfall × 100)
  deficit: number | null; // msgs/s below expected (deficit_per_s)
  status: TopicStatus | null; // coarse per-topic health for this sample
  expected: number | null; // expected_hz (the reference band on the Hz chart)
  jitterP95: number | null; // ms (inter-arrival p95 — choppiness)
  samplesLost: number | null; // cumulative DDS sample-lost count (real loss)
}

export interface MetricHistory {
  history: Map<string, MetricSample[]>;
  /** Topics that have history, most-recently-active first. */
  topics: string[];
  /** Backend monitoring pause state (distinct from the local chart freeze). */
  paused: boolean;
  /** Monotone tick suitable as a memo dependency. */
  updatedAt: number;
}

const MAX_POINTS = 600; // per topic (≈5m @ 1–2 Hz)
const HORIZON_MS = 300_000; // longest window we ever display

export function useMetricHistory(config: RuntimeConfig, frozen: boolean): MetricHistory {
  const expectedHzPatterns = useMemo(
    () => Object.entries(config.defaults.expected_hz ?? {}),
    [config],
  );
  const expectedHz = useMemo(
    () =>
      (name: string): number | undefined => {
        const hit = expectedHzPatterns.find(([pat]) => matchesTopic(pat, name));
        return hit ? hit[1] : undefined;
      },
    [expectedHzPatterns],
  );

  // SSE-fed metrics cache (written by useEventStream); never fetched here.
  const sseOnly = () => {
    throw new Error('SSE-only cache: written by useEventStream');
  };
  const metricsQuery = useQuery<MetricsSnapshot>({
    queryKey: queryKeys.metrics,
    queryFn: sseOnly,
    enabled: false,
  });

  const historyRef = useRef<Map<string, MetricSample[]>>(new Map());
  // Guard against appending the same snapshot twice (StrictMode double-invoke or
  // a re-render that doesn't carry a fresh snapshot).
  const lastSeenRef = useRef<number>(0);
  // Local monotone tick: bumps on every accumulated snapshot. Used both as the
  // re-render trigger and the memo dependency (the SSE query's `dataUpdatedAt`
  // does NOT change when we append + setTick, so deriving `topics` off it would
  // never repopulate the list after the first snapshot).
  const [tick, setTick] = useState(0);

  const dataUpdatedAt = metricsQuery.dataUpdatedAt;
  useEffect(() => {
    if (frozen) return;
    const snap = metricsQuery.data;
    if (!snap || dataUpdatedAt === lastSeenRef.current) return;
    lastSeenRef.current = dataUpdatedAt;
    const now = Date.now();
    const hist = historyRef.current;
    // Defensive: a malformed snapshot could omit `topics`; treat it as empty
    // rather than throwing (which would tear down the Graph tab).
    for (const m of snap.topics ?? []) {
      const exp = expectedHz(m.name);
      const sample: MetricSample = {
        t: now,
        hz: m.hz ?? null,
        bw: m.bandwidth_bps != null ? m.bandwidth_bps / 1e6 : null,
        gap: m.gap_max_ms ?? null,
        lat: m.stamp_delay_ms ?? null,
        loss: m.loss_rate != null ? m.loss_rate * 100 : null,
        rate: m.hz != null && exp ? (m.hz / exp) * 100 : null,
        shortfall: m.rate_shortfall != null ? m.rate_shortfall * 100 : null,
        deficit: m.deficit_per_s ?? null,
        status: m.status ?? null,
        expected: exp ?? null,
        jitterP95: m.interarrival_p95_ms ?? null,
        samplesLost: m.dds_samples_lost ?? null,
      };
      const arr = hist.get(m.name) ?? [];
      arr.push(sample);
      // Trim to the longest window horizon + the hard cap.
      const cutoff = now - HORIZON_MS;
      let head = arr[0];
      while (head && (head.t < cutoff || arr.length > MAX_POINTS)) {
        arr.shift();
        head = arr[0];
      }
      hist.set(m.name, arr);
    }
    // Sweep EVERY topic, not just those in this snapshot: a topic that stopped
    // publishing (bag ended, robot dropped it) is never revisited by the loop
    // above, so without this it lingers forever as a frozen flat line and its
    // memory is never reclaimed. Age out old points and drop emptied topics.
    const staleCutoff = now - HORIZON_MS;
    for (const [name, arr] of hist) {
      while (arr[0] && arr[0].t < staleCutoff) arr.shift();
      if (arr.length === 0) hist.delete(name);
    }
    setTick((n) => n + 1);
  }, [dataUpdatedAt, frozen, metricsQuery.data, expectedHz]);

  // historyRef mutates in place; `tick` bumps whenever it gains a snapshot.
  const topics = useMemo(
    () =>
      [...historyRef.current.entries()]
        .filter(([, pts]) => pts.length > 0)
        .sort((a, b) => (b[1].at(-1)?.t ?? 0) - (a[1].at(-1)?.t ?? 0))
        .map(([name]) => name),
    [tick],
  );

  return {
    history: historyRef.current,
    topics,
    paused: metricsQuery.data?.paused ?? false,
    updatedAt: tick,
  };
}
