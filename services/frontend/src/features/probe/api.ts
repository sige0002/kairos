// Tiny same-origin client for the topic_probe service. The probe endpoints live
// under /probe/ (nginx reverse-proxies to the topic_probe container; the Vite dev
// server proxies it too), which is NOT under the orchestrator's /api/v1 base — so
// we use native fetch here rather than the shared api/client.ts (whose joinUrl
// would prefix the api base).

import type { ProbeFieldsResponse, ProbeTopic, ProbeTopicsResponse } from './types';

/** Same-origin base for the topic_probe reverse proxy. */
export const PROBE_BASE = '/probe';

function buildUrl(path: string, query?: Record<string, string | number>): string {
  let url = `${PROBE_BASE}${path}`;
  if (query) {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) usp.set(k, String(v));
    const qs = usp.toString();
    if (qs) url += `?${qs}`;
  }
  return url;
}

async function probeGet<T>(path: string, query?: Record<string, string>): Promise<T> {
  const resp = await fetch(buildUrl(path, query), {
    headers: { Accept: 'application/json' },
  });
  if (!resp.ok) {
    throw new Error(`probe ${path} failed: HTTP ${resp.status}`);
  }
  return (await resp.json()) as T;
}

/** GET /probe/topics -> the subscribable topic list. */
export async function fetchProbeTopics(): Promise<ProbeTopic[]> {
  const body = await probeGet<ProbeTopicsResponse>('/topics');
  return body.topics ?? [];
}

/** GET /probe/fields?topic=<name> -> numeric field paths for the topic's type. */
export async function fetchProbeFields(topic: string): Promise<ProbeFieldsResponse> {
  return probeGet<ProbeFieldsResponse>('/fields', { topic });
}

/** URL of the SSE sample stream for one field of one topic (capped server-side). */
export function probeStreamUrl(topic: string, field: string, hz = 10): string {
  return buildUrl('/stream', { topic, field, hz });
}
