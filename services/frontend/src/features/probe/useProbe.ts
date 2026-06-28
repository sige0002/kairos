// Data hooks for the Probe tab: topic list + per-topic field introspection
// (TanStack Query), and a multi-series live stream — one SSE per distinct topic
// (each carrying that topic's fields), merged into one time-aligned buffer so an
// overlay chart can plot many series (and several topics) at once.

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../../api/queryKeys';
import { fetchProbeFields, fetchProbeTopics, probeStreamUrl } from './api';
import type {
  ProbeFieldsResponse,
  ProbeMultiSample,
  ProbeSeries,
  ProbeTopic,
} from './types';

// Hard memory bound regardless of the time window (covers 1m @ 30 Hz ≈ 1800 pts).
const SAFETY_CAP = 3600;

/** Subscribable topics (refetched periodically so a newly-published topic shows). */
export function useProbeTopics() {
  return useQuery<ProbeTopic[]>({
    queryKey: queryKeys.probeTopics,
    queryFn: fetchProbeTopics,
    refetchInterval: 5000,
  });
}

/** Numeric field paths for the selected topic (disabled until one is picked). */
export function useProbeFields(topic: string | null) {
  return useQuery<ProbeFieldsResponse>({
    queryKey: queryKeys.probeFields(topic ?? ''),
    queryFn: () => fetchProbeFields(topic as string),
    enabled: !!topic,
  });
}

export type ProbeStreamStatus = 'idle' | 'connecting' | 'open' | 'closed';

export interface ProbeSeriesData {
  /** uPlot AlignedData: ``[xs, ...ysPerSeries]`` (y order matches the input series). */
  data: (number | null)[][];
  status: ProbeStreamStatus;
}

/**
 * Open one SSE stream per distinct topic (each carrying that topic's fields) and
 * merge them into a single forward-filled, time-aligned buffer for an overlay
 * chart. Cross-topic overlay = several concurrent streams. Resets on series
 * change; a no-op when not live, no series, or EventSource is unavailable (tests).
 */
export function useProbeSeries(
  series: ProbeSeries[],
  live: boolean,
  hz = 10,
  windowSec = 30,
): ProbeSeriesData {
  const [data, setData] = useState<(number | null)[][]>([[]]);
  const [status, setStatus] = useState<ProbeStreamStatus>('idle');
  const xsRef = useRef<number[]>([]);
  const ysRef = useRef<(number | null)[][]>([]);
  const lastRef = useRef<Map<string, number | null>>(new Map());
  // Window via a ref so changing it just affects trimming — no stream re-open.
  const windowRef = useRef(windowSec);
  windowRef.current = windowSec;

  const seriesKey = series.map((s) => `${s.id}:${s.topic}::${s.field}`).join('|');

  // Reset the buffer whenever the series set changes.
  useEffect(() => {
    xsRef.current = [];
    ysRef.current = series.map(() => []);
    lastRef.current = new Map();
    setData([[]]);
  }, [seriesKey]);

  useEffect(() => {
    if (!live || series.length === 0) {
      setStatus('idle');
      return;
    }
    if (typeof EventSource === 'undefined') return; // non-browser / test env

    // Group field paths by topic -> one stream per topic.
    const byTopic = new Map<string, string[]>();
    for (const s of series) {
      const arr = byTopic.get(s.topic) ?? [];
      arr.push(s.field);
      byTopic.set(s.topic, arr);
    }

    setStatus('connecting');
    const sources: EventSource[] = [];
    byTopic.forEach((fields, topic) => {
      const es = new EventSource(probeStreamUrl(topic, fields, hz));
      es.onopen = () => setStatus('open');
      es.onerror = () =>
        setStatus(es.readyState === EventSource.CLOSED ? 'closed' : 'connecting');
      es.onmessage = (ev: MessageEvent<string>) => {
        let m: ProbeMultiSample;
        try {
          m = JSON.parse(ev.data) as ProbeMultiSample;
        } catch {
          return;
        }
        // Update last-known values for this topic's series.
        series.forEach((s) => {
          if (s.topic === m.topic) lastRef.current.set(s.id, m.values[s.field] ?? null);
        });
        // Append one time-aligned column (forward-filled across all series).
        const now = Date.now() / 1000;
        xsRef.current.push(now);
        series.forEach((s, i) => {
          (ysRef.current[i] ??= []).push(lastRef.current.get(s.id) ?? null);
        });
        // Drop points older than the selected time window (don't keep forever),
        // with a hard safety cap so memory stays finite at very high Hz.
        const xs = xsRef.current;
        const cutoff = now - windowRef.current;
        let drop = 0;
        while (drop < xs.length && xs[drop]! < cutoff) drop++;
        if (xs.length - drop > SAFETY_CAP) drop = xs.length - SAFETY_CAP;
        if (drop > 0) {
          xs.splice(0, drop);
          ysRef.current.forEach((y) => y.splice(0, drop));
        }
        setData([[...xs], ...ysRef.current.map((y) => [...y])]);
      };
      sources.push(es);
    });

    return () => {
      sources.forEach((es) => es.close());
      setStatus('closed');
    };
  }, [seriesKey, live, hz]);

  return { data, status };
}
