// Data hooks for the Probe tab: topic list + per-topic field introspection
// (TanStack Query, keyed via the frozen queryKeys), and a live SSE sample stream
// accumulated into a rolling client-side buffer for the plot.

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../../api/queryKeys';
import { fetchProbeFields, fetchProbeTopics, probeStreamUrl } from './api';
import type { ProbeFieldsResponse, ProbePoint, ProbeSample, ProbeTopic } from './types';

const MAX_POINTS = 600; // ring-buffer cap (~1m @ 10 Hz)

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

export interface ProbeStream {
  points: ProbePoint[];
  status: ProbeStreamStatus;
  /** Latest non-null value seen (for the headline readout). */
  latest: number | null;
}

/**
 * Open an SSE stream of {t, value} samples for one field of one topic and
 * accumulate them into a rolling buffer. Closing/reopening on topic/field/active
 * change. A no-op when EventSource is unavailable (e.g. the test env) or when not
 * active / no field is selected.
 */
export function useProbeStream(
  topic: string | null,
  field: string | null,
  active: boolean,
  hz = 10,
): ProbeStream {
  const [points, setPoints] = useState<ProbePoint[]>([]);
  const [status, setStatus] = useState<ProbeStreamStatus>('idle');
  const [latest, setLatest] = useState<number | null>(null);
  const bufferRef = useRef<ProbePoint[]>([]);

  // Reset the buffer whenever the plotted series changes.
  useEffect(() => {
    bufferRef.current = [];
    setPoints([]);
    setLatest(null);
  }, [topic, field]);

  useEffect(() => {
    if (!active || !topic || !field) {
      setStatus('idle');
      return;
    }
    if (typeof EventSource === 'undefined') return; // non-browser / test env

    setStatus('connecting');
    const es = new EventSource(probeStreamUrl(topic, field, hz));
    es.onopen = () => setStatus('open');
    es.onerror = () => {
      setStatus(es.readyState === EventSource.CLOSED ? 'closed' : 'connecting');
    };
    es.onmessage = (ev: MessageEvent<string>) => {
      let sample: ProbeSample;
      try {
        sample = JSON.parse(ev.data) as ProbeSample;
      } catch {
        return;
      }
      const buf = bufferRef.current;
      buf.push({ t: Date.now(), value: sample.value });
      if (buf.length > MAX_POINTS) buf.splice(0, buf.length - MAX_POINTS);
      bufferRef.current = buf;
      setPoints([...buf]);
      if (sample.value !== null) setLatest(sample.value);
    };

    return () => {
      es.close();
      setStatus('closed');
    };
  }, [active, topic, field, hz]);

  return { points, status, latest };
}
