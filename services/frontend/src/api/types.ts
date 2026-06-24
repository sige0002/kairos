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
  /** Who is collecting the data (free text); saved to the run + session.json. */
  operator?: string;
  /** Task / scenario being recorded (free text); saved likewise. */
  task?: string;
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
  operator?: string | null;
  task?: string | null;
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

/**
 * Per-topic live health metrics from topic_monitor (via the orchestrator).
 * Field names mirror the backend `TopicMetrics` model exactly (see
 * topic_monitor/models.py). `hz` / `bandwidth_bps` / `gap_max_ms` are computed
 * once samples arrive; the Late split (`inter_arrival_late_ratio` +
 * `stamp_delay_ms`) and `loss_rate` are null when they can't be computed and
 * `reason` says why.
 */
export interface TopicMetric {
  name: string;
  type?: string | null;
  hz?: number | null;
  bandwidth_bps?: number | null;
  gap_max_ms?: number | null;
  gap_exceed_count?: number;
  inter_arrival_late_ratio?: number | null;
  stamp_delay_ms?: number | null;
  loss_rate?: number | null;
  reason?: string | null;
}

/** A periodic metrics snapshot delivered over SSE (`event: metrics`). */
export interface MetricsSnapshot {
  ts?: string;
  window_s?: number;
  topics: TopicMetric[];
  paused?: boolean;
}

/** An active/cleared alert (backend `Alert` model). */
export interface AlertEvent {
  topic: string;
  metric: AlertMetric;
  op?: 'lt' | 'gt' | 'le' | 'ge';
  threshold: number;
  value?: number | null;
  state?: 'firing' | 'cleared';
  since?: string | null;
}

/** The `alert` SSE event payload: a snapshot of current alerts. */
export interface AlertSnapshot {
  ts?: string;
  alerts: AlertEvent[];
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
