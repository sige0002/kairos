// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Probe-tab-local types (lane-local; NOT added to src/api/types.ts). These
// mirror the topic_probe service contract (services/topic_probe/src/.../models.py),
// consumed same-origin via the nginx /probe/ proxy.

/** One subscribable topic from GET /probe/topics. */
export interface ProbeTopic {
  name: string;
  type: string | null;
}

/** Body of GET /probe/topics. */
export interface ProbeTopicsResponse {
  ts: string;
  topics: ProbeTopic[];
}

/** Body of GET /probe/fields?topic=<name>: dotted numeric field paths. */
export interface ProbeFieldsResponse {
  ts: string;
  topic: string;
  type: string | null;
  fields: string[];
  reason?: string | null;
}

/** One streamed sample (GET /probe/sample and the /probe/stream SSE frames). */
export interface ProbeSample {
  topic: string;
  field: string;
  /** Wall-clock seconds (chart x-axis). */
  t: number;
  /** Field value, or null when it did not resolve on the latest message. */
  value: number | null;
}

/** One accumulated point in the live plot buffer. */
export interface ProbePoint {
  /** Local wall-clock ms (when the sample was received). */
  t: number;
  value: number | null;
}

/** One multi-field SSE frame (GET /probe/stream?topic&fields=...): one topic's
 * fields sampled off the same decoded message. */
export interface ProbeMultiSample {
  topic: string;
  /** Wall-clock seconds. */
  t: number;
  /** field path -> value (null when it did not resolve on the latest message). */
  values: Record<string, number | null>;
}

/** One overlay series in the Probe chart: a (topic, field) pair. */
export interface ProbeSeries {
  id: string;
  topic: string;
  field: string;
}
