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

/**
 * Recorder "arming" state (OL-①.4): while start_paused is in effect the recorder
 * is subscribed-but-paused, waiting for the target topics to appear on the graph
 * before it resumes (begins writing). Surfaced so the UI can show what is matched
 * vs still-missing and when the auto-resume timeout fires.
 */
export interface RecordArming {
  /** True while paused and waiting for target topics (pre-resume). */
  active: boolean;
  /** Target topics already present on the ROS graph (recorder subscribed). */
  matched_topics: string[];
  /** Target topics still missing (recorder waiting on these). */
  missing_topics: string[];
  /** ISO8601 instant the recorder auto-resumes anyway (readiness timeout). */
  resume_at?: string | null;
}

export interface RecordStatus {
  run_id: string | null;
  state: RunState | 'idle';
  message_count?: number;
  bytes?: number;
  /** Present only while arming (state stays `recording` once resumed). */
  arming?: RecordArming | null;
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
  operator?: string | null;
  task?: string | null;
}

/** `dataset_export` job summary (dora_runner): one exported dataset directory. */
export interface DatasetExportSummary {
  run_id?: string;
  operator?: string;
  task?: string;
  /** Zero-padded index allocated under data/<operator>/<task>/ (e.g. "001"). */
  index?: string;
  dataset_dir?: string;
  files?: string[];
  bytes?: number;
  message_count?: number | null;
  exported_at?: string;
}

/** One exported dataset directory under data/<operator>/<task>/<NNN> (GET /datasets). */
export interface DatasetEntry {
  operator: string;
  task: string;
  /** Zero-padded index allocated under data/<operator>/<task>/ (e.g. "001"). */
  index: string;
  dataset_dir: string;
  run_id?: string;
  bytes?: number;
  message_count?: number | null;
  exported_at?: string;
}

/** GET /api/v1/datasets — the flat list of exported datasets (grouped in the UI). */
export interface DatasetsResponse {
  datasets: DatasetEntry[];
}

/** POST /api/v1/datasets/export-all — per-run successes + failures for the batch. */
export interface ExportAllResponse {
  exported: DatasetExportSummary[];
  failed: { run_id: string; error: string }[];
  total: number;
}

/**
 * `video_check` job summary (dora_runner): an on-demand mp4 preview of one
 * camera topic. `file` is the path relative to data_dir (fetch it via
 * `${apiBase}/files/${file}`); `frames === 0` means nothing decodable was found.
 */
export interface VideoCheckSummary {
  run_id?: string;
  topic?: string;
  frames?: number;
  fps?: number | null;
  width?: number | null;
  height?: number | null;
  duration_s?: number | null;
  truncated?: boolean;
  total_messages?: number;
  /** mp4 path relative to data_dir, for `${apiBase}/files/<file>`. */
  file?: string | null;
  mp4?: string | null;
  note?: string;
  checked_at?: string;
}

/** One topic's gap-based loss estimate from the `loss_report` pipeline. */
export interface LossTopic {
  name: string;
  type?: string;
  count?: number;
  hz?: number | null;
  loss_rate?: number | null;
  gap_max_ms?: number | null;
  median_interval_ms?: number | null;
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
  /** `loss_report` per-topic gap-based loss summary (when computed). */
  loss?: { run_id?: string; topics?: LossTopic[]; checked_at?: string } | null;
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
/**
 * Coarse per-topic health (topic_monitor TopicStatus), by descending severity.
 * `inactive` = silent; `danger`/`warning` = observed shortfall vs expected_hz;
 * `ok` = on rate; `unknown` = no expected_hz to judge against.
 */
export type TopicStatus = 'inactive' | 'danger' | 'warning' | 'ok' | 'unknown';

export interface TopicMetric {
  name: string;
  type?: string | null;
  hz?: number | null;
  bandwidth_bps?: number | null;
  gap_max_ms?: number | null;
  gap_exceed_count?: number;
  inter_arrival_late_ratio?: number | null;
  stamp_delay_ms?: number | null;
  // Inter-arrival jitter from receive times (no decode) — the honest "choppy" signal.
  interarrival_p50_ms?: number | null;
  interarrival_p95_ms?: number | null;
  loss_rate?: number | null;
  // Cumulative DDS sample-lost count (rmw message_lost) — the one honest "real loss".
  dds_samples_lost?: number;
  // Observed shortfall vs static expected_hz (NOT true loss). null without expected_hz.
  rate_shortfall?: number | null;
  deficit_per_s?: number | null;
  // Coarse health + reason (derived from rate_shortfall).
  status?: TopicStatus;
  status_reason?: string | null;
  reason?: string | null;
  // Dynamic baseline (OL-②.3): learned Hz reference used to judge shortfall when
  // the topic has no static expected_hz. `baseline_state` is "learning" during
  // warm-up (status stays `unknown`), then "stable" / "unstable".
  baseline_hz?: number | null;
  baseline_state?: 'learning' | 'stable' | 'unstable' | null;
}

/**
 * Monitor self-load (OL-②.4): the monitor process's OWN processing health,
 * separate from topic health and never derived from decoding payloads. Lets the
 * UI distinguish "the topics are slow" from "the monitor itself is overloaded".
 */
export interface MonitorSelfLoad {
  /** Mean sample-callback processing time over the window (ms). */
  callback_lag_ms?: number | null;
  /** p95 sample-callback processing time (ms). */
  callback_lag_p95_ms?: number | null;
  /**
   * Staleness of the freshest data the monitor holds (s), from the most recent
   * receive time across active topics; large = the monitor is falling behind.
   */
  snapshot_age_s?: number | null;
  status?: 'ok' | 'warning' | 'danger';
}

/** A periodic metrics snapshot delivered over SSE (`event: metrics`). */
export interface MetricsSnapshot {
  ts?: string;
  window_s?: number;
  topics: TopicMetric[];
  paused?: boolean;
  /** Monitor's own processing health (OL-②.4); null when self-load is off. */
  self_load?: MonitorSelfLoad | null;
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

// ---- Config catalog (Config tab) ----------------------------------------

/** One selectable robot (a committed config/<robot>/ or gitignored local one). */
export interface RobotOption {
  id: string;
  local: boolean;
}

/** Display metadata for an aspect option (aspect-specific; all optional). */
export interface AspectOptionMeta {
  name?: string;
  version?: number;
  required_topics?: { name: string; type?: string | null }[];
  default_topics?: number;
  columns?: number;
  panes?: number;
}

/** One selectable `*.yaml` option within an aspect of the active robot. */
export interface AspectOption {
  id: string;
  path: string;
  local: boolean;
  meta: AspectOptionMeta;
}

/** The four selectable config aspects of a robot. */
export type ConfigAspect = 'recording' | 'stream' | 'validation' | 'validators';

/**
 * GET /api/v1/config/options — robot-first selectable config. Pick the active
 * robot, then per aspect pick which option is active.
 */
export interface ConfigOptions {
  active_robot: string;
  robots: RobotOption[];
  aspects: Record<ConfigAspect, { active: string; options: AspectOption[] }>;
}

/**
 * A validation template, adapted from the active robot's `validation` aspect
 * options for the fast_validation params form (PipelineForm `templateOptions`).
 */
export interface ValidationOption {
  id: string;
  name: string;
  version: number;
  required_topics: { name: string; type?: string | null }[];
}

/**
 * GET/PUT /api/v1/config/recording — the full editable RECORDING_CONFIG.
 * `config` is the RecordingConfig object (or null when none is loaded); `path`
 * is the on-prem file the orchestrator persists to. The shape is intentionally
 * opaque (`Record<string, unknown>`) because the whole config is edited as JSON.
 */
export interface RecordingConfigPayload {
  config: Record<string, unknown> | null;
  path: string;
}

// ---- Pipelines / Jobs ---------------------------------------------------

export interface PipelineInfo {
  id: string;
  name?: string;
  description?: string;
  /** Interface-only placeholders report `false`; only `true` pipelines run. */
  enabled?: boolean;
}

export interface JobSubmitRequest {
  pipeline: string;
  /** Required by the backend (JobCreateRequest.run_id); every job targets a run. */
  run_id: string;
  params?: Record<string, unknown>;
}

/** Terminal job result (GET /api/v1/jobs/{id}/result). */
export interface JobResult {
  /** Pipeline-specific summary; for `fast_validation` it is a ValidationSummary. */
  summary: ValidationSummary & Record<string, unknown>;
  artifacts?: string[];
}

/** `fast_validation` summary shape (dora_runner validator). */
export interface ValidationSummary {
  template?: { name?: string; version?: number };
  result?: 'pass' | 'fail';
  /** Required topics that were NOT found in the recording. */
  missing?: { name: string; type?: string | null }[];
  /** Recorded topics not matched by any required entry (informational). */
  extra?: { name: string; type?: string | null }[];
  checked_at?: string;
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
  /** Arming progress (OL-①.4); present while paused/waiting, omitted once resumed. */
  arming?: RecordArming | null;
}

export type SseEventType = 'record_status' | 'metrics' | 'alert' | 'job' | 'resync';
