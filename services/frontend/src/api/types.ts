// Domain types for the api_orchestrator REST/SSE contract.
// Source of truth: docs/specs/ja/api_orchestrator.md and config.md.

export type RunState =
  | 'created'
  | 'recording'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'interrupted';

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

export type Encoding = 'vp8' | 'h264';

export type AlertMetric = 'hz' | 'bandwidth' | 'gap' | 'late' | 'loss';
export type AlertLevel = 'info' | 'warn' | 'critical';

/** Common API error envelope: { error: { code, message, details } }. */
export interface ApiErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

// ---- Record -------------------------------------------------------------

export interface RecordStartRequest {
  topics: string[] | 'all';
  compression?: 'none' | 'zstd';
  split?: { max_size_mb?: number | null; max_duration_s?: number | null } | null;
  [key: string]: unknown;
}

export interface RecordStartResponse {
  run_id: string;
  state: RunState;
}

export interface RecordStatus {
  run_id: string | null;
  state: RunState | 'idle';
  message_count?: number;
  bytes?: number;
}

// ---- Runs ---------------------------------------------------------------

export interface RunTopic {
  name: string;
  type: string;
  qos?: Record<string, unknown> | string;
}

export interface RunSummary {
  run_id: string;
  state: RunState;
  started_at?: string;
  ended_at?: string | null;
  duration_ms?: number;
}

export interface RunDetail {
  run_id: string;
  state: RunState;
  started_at?: string;
  ended_at?: string | null;
  topics: RunTopic[];
  compression?: string;
  split?: Record<string, unknown> | null;
  error?: { code: string; message: string } | null;
  /** Optional audit manifest + stats surfaced by the orchestrator. */
  manifest?: Record<string, unknown> | null;
  validation?: Record<string, unknown> | null;
  dataset_stats?: Record<string, unknown> | null;
}

// ---- Topics / Monitor ---------------------------------------------------

export interface TopicInfo {
  name: string;
  type: string;
  publisher_count?: number;
  subscriber_count?: number;
  qos?: Record<string, unknown> | string;
  last_seen?: string;
}

/** Per-topic live health metrics from topic_monitor (via the orchestrator). */
export interface TopicMetric {
  topic: string;
  hz?: number;
  expected_hz?: number;
  late_ms?: number;
  gap?: number;
  loss?: number;
  bandwidth_bps?: number;
}

/** A periodic metrics snapshot delivered over SSE (`event: metrics`). */
export interface MetricsSnapshot {
  ts?: string;
  topics: TopicMetric[];
}

export interface AlertEvent {
  topic: string;
  metric: AlertMetric;
  level: AlertLevel;
  value: number;
  threshold: number;
  ts?: string;
}

// ---- Pipelines / Jobs ---------------------------------------------------

export interface PipelineInfo {
  id: string;
  name?: string;
  description?: string;
}

export interface JobSubmitRequest {
  pipeline: string;
  run_id?: string;
  params?: Record<string, unknown>;
}

export interface JobStatus {
  job_id: string;
  run_id?: string;
  pipeline: string;
  state: JobState;
  progress?: number;
  logs_tail?: string[];
}

// ---- Cursor pagination --------------------------------------------------

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

// ---- SSE event payloads -------------------------------------------------

export interface RecordStatusEvent {
  run_id: string;
  state: RunState;
  message_count?: number;
  bytes?: number;
}

export type SseEventType = 'record_status' | 'metrics' | 'alert' | 'job' | 'resync';
