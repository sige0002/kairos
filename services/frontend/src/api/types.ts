// Domain types for the api_orchestrator REST/SSE contract.
// Source of truth: docs/specs/ja/api_orchestrator.md and config.md.

export type RunState =
  | 'created'
  | 'recording'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'interrupted'
  /** Two-phase start: a `/record/prepare`d session is spawned + subscribed but
   *  paused, waiting for a matching start (never persisted — no run row). */
  | 'armed';

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
  /** Target topics with NO publisher on the graph — genuinely not publishing. */
  missing_topics: string[];
  /** Target topics that ARE published but the recorder has not subscribed to
   *  yet (DDS discovery catching up). Absent on an older recorder — treat as
   *  empty, never fold it into `missing_topics`: these ARE publishing, and the
   *  operator can see them live in Monitor. */
  unsubscribed_topics?: string[];
  /** ISO8601 instant the recorder auto-resumes anyway (readiness timeout). */
  resume_at?: string | null;
  /** ISO8601 instant an `armed` (two-phase prepare) session auto-disarms if no
   *  matching start claims it; the pre-arm keep-alive re-prepares before this. */
  disarm_at?: string | null;
}

/** Body of `POST /api/v1/record/prepare` (two-phase start): the recorder is now
 *  armed — spawned + subscribed but paused — until a matching start resumes it,
 *  a mismatching one replaces it, or `disarm_at` passes unclaimed. */
export interface RecordPrepareResponse {
  run_id: string;
  state: RunState;
  arming?: RecordArming | null;
  disarm_at?: string | null;
}

/**
 * Recording integrity (OL-①): a clean run that still lost messages to the
 * in-recorder cache is `completed` + integrity `dropped`. `dropped_messages` is
 * rosbag2's self-reported "Total lost" (null until known / log unavailable).
 */
export type RecordIntegrity = 'ok' | 'dropped' | 'failed' | 'unknown';

export interface RecordStatus {
  run_id: string | null;
  state: RunState | 'idle';
  /** Actual capture start (recorder-stamped, post arming/resume) — the elapsed
   *  timer's baseline, available on the same poll that flips the UI to red. */
  started_at?: string | null;
  message_count?: number;
  bytes?: number;
  /** Present only while arming (state stays `recording` once resumed). */
  arming?: RecordArming | null;
  integrity?: RecordIntegrity;
  dropped_messages?: number | null;
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
  /** Console v2 Phase 2: the episode this run belongs to (null when none),
   *  additively joined by the runs read path so Review shows real data on any
   *  terminal. Never persisted on the run row. */
  episode?: RunEpisode | null;
  /** Whether a finalised local copy of the recording exists on the serving
   *  host (`recorded/<run_id>/metadata.yaml` present in the FINAL path — the
   *  importer stages in-flight pulls and atomic-renames on completion, so it
   *  is the "fully imported" marker). False on a split recording PC until the
   *  run is pulled; the Review transfer UI keys on it. */
  bag_local?: boolean | null;
}

/** One recording surfaced by `GET /api/v1/retention` as old-and-unexported.
 *  Advisory only — a candidate for the operator to review, never auto-deleted. */
export interface RetentionCandidate {
  run_id: string;
  started_at?: string | null;
  bytes?: number | null;
  state: RunState;
  has_episode: boolean;
}

/** `GET /api/v1/retention`: deletion candidates by retention period. `days` is
 *  the active `RETENTION_DAYS` (0 = feature off → always empty candidates). */
export interface RetentionInfo {
  days: number;
  candidates: RetentionCandidate[];
  total_bytes: number;
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
  /** Stable hash of the topics the bag ACTUALLY contains (name + type of every
   *  topic that recorded at least one message), derived at export from the
   *  bag's rosbag2 `metadata.yaml`. Two episodes with the same hash share an
   *  observation/action space; a differing hash inside one group means the
   *  group can't convert into a single training set. Null when the export's
   *  metadata was unreadable — an honest UNKNOWN that must be kept OUT of the
   *  comparison, never treated as its own set. */
  topics_hash?: string | null;
  /** How many topics fed `topics_hash` (shown as "7 topics"). */
  topic_count?: number | null;
  /** Console v2 Phase 2: episode-label subset for catalog cards. The backend
   *  serves these FLAT on each list row (mirroring its per-row dataset.json
   *  read); null/absent on older backends or pre-label exports. The full
   *  nested `episode` object exists only on DatasetDetail. */
  task_result?: 'success' | 'failure' | null;
  /** The operator's failure reason picked at save time; null for successes
   *  and pre-label exports. */
  failure_reason?: string | null;
  quality?: 'good' | 'needs_review' | 'not_usable' | null;
  review_status?: 'pending' | 'adopted' | 'excluded' | null;
  batch_seq?: number | null;
  index_in_batch?: number | null;
  /** Globally-unique batch id (batch_seq resets per robot per day, so it
   *  can't identify a batch alone); null until a catalog rebuild heals
   *  pre-existing rows. */
  batch_id?: string | null;
  /** The batch's recording condition, flattened out of episode.json's batch
   *  context; null on pre-label exports. */
  condition?: string | null;
}

/** GET /api/v1/datasets — the flat list of exported datasets (grouped in the UI). */
export interface DatasetsResponse {
  datasets: DatasetEntry[];
}

/**
 * GET /api/v1/datasets/archive/config — whether a dataset may be archived off
 * this machine, and to which roots. `enabled: false` (KAIROS_ARCHIVE_ROOTS
 * unset) means the feature is not offered: the UI renders no archive control
 * at all rather than one whose only possible outcome is a 400.
 */
export interface ArchiveConfig {
  enabled: boolean;
  /** Absolute paths a destination must sit inside. Empty when disabled. */
  roots: string[];
}

/** 202 body of POST /api/v1/datasets/{op}/{task}/{index}/archive. The copy runs
 *  as a job (multi-GB over a NAS), so this carries the id to poll. */
export interface DatasetArchiveResponse {
  job_id: string;
  pipeline: string;
  destination: string;
}

/**
 * GET /api/v1/datasets/{operator}/{task}/{index} — one exported dataset plus
 * its on-disk sidecars: the post-export counterpart of RunDetail, so the
 * Datasets tab can show the same inspection view as Recordings. All sidecar
 * fields are best-effort (null when the file is absent/unreadable).
 */
export interface DatasetDetail {
  operator: string;
  task: string;
  index: string;
  /** Relative "<operator>/<task>/<index>" under data/ — the `dataset_dir` job
   *  param for post-export video_check / loss_report. */
  path: string;
  dataset_dir: string;
  run_id?: string | null;
  state?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  exported_at?: string | null;
  bytes?: number | null;
  message_count?: number | null;
  files: string[];
  /** From manifest.json when present (name+type+QoS); else name-only (type ""). */
  topics: RunTopic[];
  manifest?: Record<string, unknown> | null;
  /** The dataset.json provenance summary itself. */
  dataset?: Record<string, unknown> | null;
  validation?: Record<string, unknown> | null;
  /** `loss_report` summary that survived export (or was re-run post-export). */
  loss?: { run_id?: string; topics?: LossTopic[]; checked_at?: string } | null;
  /** Console v2 Phase 2: the episode this exported run belongs to (null/absent
   *  on older backends). Drives the detail's label chips; nothing when absent. */
  episode?: RunEpisode | null;
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
  /** Encode cap the summary was produced with; 0 = the full episode. */
  max_frames?: number;
  /** mp4 path relative to data_dir, for `${apiBase}/files/<file>`. */
  file?: string | null;
  mp4?: string | null;
  note?: string;
  checked_at?: string;
  /** True when served from the per-(run, topic) cache instead of re-encoding. */
  cached?: boolean;
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

/** Per-topic downsample metadata for a `signal_report` topic. */
export interface SignalDownsample {
  /** Keep-every-Nth stride applied to fit `max_points`. */
  stride: number;
  /** Point count after downsampling. */
  points: number;
}

/**
 * One topic in a `signal_report`: its decoded numeric fields sampled over the
 * episode timeline. `t_ns` is EPISODE-relative nanoseconds (0-based, so it stays
 * within JS number precision) shared by every field array; `fields` maps a
 * dotted field path (same vocabulary as the live Probe view) to its per-sample
 * values (null where the field did not resolve on that message). `continuity` is
 * a 0..1 score whose meaning is spelled out verbatim in `continuity_definition`
 * (shown in the UI so the number is never presented without its formula).
 */
export interface SignalTopicReport {
  msg_type?: string | null;
  message_count?: number;
  start_ns?: number;
  end_ns?: number;
  continuity?: number | null;
  continuity_definition?: string | null;
  /** Clock rule resolved for THIS topic (e.g. "publish_time") — per-topic, so it
   *  lives on the topic entry, not the report. `t_ns` is sorted/monotonic and
   *  co-sorted with every field array (safe to feed uPlot directly). */
  time_source?: string;
  downsample?: SignalDownsample | null;
  t_ns: number[];
  fields: Record<string, (number | null)[]>;
  truncated_fields?: number;
}

/**
 * `signal_report` job summary (dora_runner): per-topic decoded numeric signals
 * over episode time, for the Review detail's Signals section. `skipped_topics`
 * maps a topic to a plain-language reason it carries no numeric series (e.g. an
 * image topic → use video_check).
 */
export interface SignalReport {
  pipeline?: string;
  /** Sidecar schema version (additive; unknown top-level keys are ignored). */
  version?: string;
  run_id?: string;
  generated_at?: string;
  /** `topics` is null when the job ran with defaults (all numeric topics). */
  params?: { topics?: string[] | null; max_points?: number };
  topics: Record<string, SignalTopicReport>;
  /** Topic → human-readable reason it carries no numeric series. */
  skipped_topics?: Record<string, string>;
}

/** One topic's layer-0 (live monitor at stop) quick-check figures. */
export interface QuickCheckLayer0Topic {
  hz?: number | null;
  expected_hz?: number | null;
  rate_shortfall?: number | null;
  gap_max_ms?: number | null;
  dds_samples_lost?: number;
}

/** Layer 0: what the topic_monitor observed live, captured at recording stop. */
export interface QuickCheckLayer0 {
  available: boolean;
  integrity?: RecordIntegrity | string;
  topics?: Record<string, QuickCheckLayer0Topic>;
  incidents?: string[];
}

/** One topic's layer-1 (post-hoc bag summary) quick-check figures. */
export interface QuickCheckLayer1Topic {
  message_count?: number;
  avg_hz?: number | null;
  expected_hz?: number | null;
}

/** Layer 1: what the MCAP summary reports (needs a clean end-of-recording). */
export interface QuickCheckLayer1 {
  available: boolean;
  summary_available?: boolean;
  topics?: Record<string, QuickCheckLayer1Topic>;
  missing_topics?: string[];
  empty_topics?: string[];
  duration_s?: number | null;
}

/** The bottom-line quick-check call plus the reasons behind it (the "why is this
 *  needs_review" answer surfaced in Review so nobody has to open JSON). */
export interface QuickCheckVerdict {
  quality: 'good' | 'needs_review';
  reasons: string[];
}

/**
 * Fast pre-review quick-check attached to a run/episode: a cheap two-layer
 * health read (live monitor at stop + bag summary) with a plain-language
 * verdict. Absent on runs recorded before the feature — the UI then shows
 * nothing (no fabricated state); a layer with `available:false` /
 * `summary_available:false` is stated as honestly unavailable.
 */
export interface QuickCheck {
  computed_at?: string;
  elapsed_ms?: number;
  layer0?: QuickCheckLayer0 | null;
  layer1?: QuickCheckLayer1 | null;
  verdict?: QuickCheckVerdict | null;
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
  /** Console v2 Phase 2: the episode this run belongs to (null when none). */
  episode?: RunEpisode | null;
  /** Optional audit manifest + stats surfaced by the orchestrator. */
  manifest?: Record<string, unknown> | null;
  validation?: Record<string, unknown> | null;
  dataset_stats?: Record<string, unknown> | null;
  /** `loss_report` per-topic gap-based loss summary (when computed). */
  loss?: { run_id?: string; topics?: LossTopic[]; checked_at?: string } | null;
  /** `signal_report` sidecar (per-topic decoded numeric fields over episode
   *  time), when the orchestrator surfaces it on the run. The Signals section
   *  fetches it via the job-result path too, so this is a convenience mirror. */
  signal?: SignalReport | null;
  /** Fast pre-review quick-check verdict, when present (absent on old runs). */
  quick_check?: QuickCheck | null;
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

/** One aspect's selected/default file in the read-only robot view. */
export interface RobotAspectFile {
  id: string;
  path: string;
  local: boolean;
  /** Best-effort parsed YAML mapping (null when unreadable / not a mapping). */
  content: Record<string, unknown> | null;
}

/** Derived, display-only summary of a robot's recording config. */
export interface RobotConfigSummary {
  robot_name: string;
  default_topics: string[];
  /** Present only if a config file carries it (not a RecordingConfig field). */
  ros_domain_id?: number | null;
}

/**
 * GET /api/v1/config/robots/{robot} — read-only config for a named robot,
 * active or not. Lets Settings show a non-active robot's config as a template
 * without switching the live system (D-5-2).
 */
export interface RobotConfig {
  robot: string;
  local: boolean;
  active: boolean;
  summary: RobotConfigSummary;
  aspects: Record<ConfigAspect, RobotAspectFile | null>;
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
  /** Declared output contract, e.g. `report/<id>/<run_id>/summary.json`. */
  outputs?: string[];
}

export interface JobSubmitRequest {
  pipeline: string;
  /** Required by the backend (JobCreateRequest.run_id); every job targets a run. */
  run_id: string;
  params?: Record<string, unknown>;
}

/**
 * A one-click validation preset (`GET /api/v1/validation/presets`). Static
 * fields come from the robot's `validation_presets.yaml`; `total`/`pending`/
 * `pending_run_ids` are computed per request — `pending_run_ids` are the
 * completed recordings this preset's pipeline has not validated yet.
 */
export interface ValidationPreset {
  id: string;
  name: string;
  description?: string;
  pipeline: string;
  params?: Record<string, unknown>;
  total: number;
  pending: number;
  pending_run_ids: string[];
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

/**
 * One entry in the Monitor "Logs" session ring buffer (Console v2). Populated by
 * useEventStream as real SSE events arrive — a faithful, browser-local record of
 * what was received since this page opened (NOT a server-side log; the full
 * service logs live in `docker compose logs`). `ts` is the client receipt time,
 * so entries are ordered by when the UI saw them.
 */
export type SessionLogType = 'record_status' | 'alert' | 'job';

export interface SessionLogEntry {
  /** Monotonic id for React keys (session-local). */
  id: number;
  /** Client receipt time (epoch ms). */
  ts: number;
  type: SessionLogType;
  /** Compact one-line summary built at receipt from the typed payload. */
  summary: string;
}

// ---- Console v2 Phase 2: batches & episodes -----------------------------
// Mirrors api_orchestrator.models (batches/episodes). Backend vocab differs
// from the Review display enums (types in v2/review/types.ts): here quality is
// 'good'|'needs_review'|'not_usable' and task result 'success'|'failure'.

export type EpisodeTaskResult = 'success' | 'failure';
export type EpisodeQuality = 'good' | 'needs_review' | 'not_usable';
export type EpisodeQualitySource = 'operator' | 'quick_check' | 'validator';
export type EpisodeReviewStatus = 'pending' | 'adopted' | 'excluded';
export type BatchStatus = 'active' | 'completed' | 'ended_early';

/** Compact episode summary joined onto a run (`Run.episode`). */
export interface RunEpisode {
  episode_id: string;
  batch_id: string;
  index_in_batch: number;
  task_result: EpisodeTaskResult;
  failure_reason?: string | null;
  quality: EpisodeQuality;
  review_status: EpisodeReviewStatus;
  /** Server-assigned per-(robot, local-date) batch number (Console v2 pipeline
   *  UX). The single human-readable batch number shared by Collect/Review/
   *  Datasets. Optional until the phase-2 backend serves it (fallback: "—"). */
  batch_seq?: number | null;
  /** The batch's created_at, so Review/Datasets can render "MM/DD · #N" without
   *  a second round-trip. Optional (falls back to the run's own started_at). */
  batch_created_at?: string | null;
}

export interface Batch {
  batch_id: string;
  robot?: string | null;
  project: string;
  task: string;
  condition?: string | null;
  operator?: string | null;
  target_episodes: number;
  status: BatchStatus;
  ended_reason?: string | null;
  created_at?: string | null;
  ended_at?: string | null;
  /** Server-assigned per-(robot, local-date) batch number — the human-readable
   *  "Batch N" shown in Collect and (as "MM/DD · #N") in Review/Datasets.
   *  Optional until the phase-2 backend serves it (fallback: honest pre-state). */
  batch_seq?: number | null;
  /** Monotone count of episodes ever recorded into this batch — never lowered
   *  by a run-delete cascade. Collect's counts use this (falls back to the
   *  live episode count on older backends that omit it). */
  episodes_recorded?: number;
}

export interface Episode {
  episode_id: string;
  batch_id: string;
  run_id: string;
  index_in_batch: number;
  task_result: EpisodeTaskResult;
  failure_reason?: string | null;
  quality: EpisodeQuality;
  quality_source: EpisodeQualitySource;
  review_status: EpisodeReviewStatus;
  created_at?: string | null;
  updated_at?: string | null;
}

/** Per-episode row inside a batch list item (`BatchSummary.episodes`). */
export interface BatchEpisodeSummary {
  index: number;
  run_id: string;
  task_result: EpisodeTaskResult;
  quality: EpisodeQuality;
  review_status: EpisodeReviewStatus;
}

export interface BatchSummary extends Batch {
  episode_count: number;
  episodes: BatchEpisodeSummary[];
}

export interface BatchDetail extends Batch {
  episode_count: number;
  episodes: Episode[];
}

export interface BatchListResponse {
  items: BatchSummary[];
}

export interface BatchCreateRequest {
  robot?: string | null;
  project: string;
  task: string;
  condition?: string | null;
  operator?: string | null;
  target_episodes?: number;
}

export interface BatchPatchRequest {
  status?: BatchStatus;
  ended_reason?: string | null;
  /** Empty-batch re-label only: Collect PATCHes project/task when the operator
   *  switches them before the batch's first recording (a batch with recordings
   *  rolls over to a new one instead). */
  project?: string | null;
  task?: string | null;
  condition?: string | null;
  /** Mid-batch plan-size change (Collect's Change target…). */
  target_episodes?: number;
}

export interface EpisodeCreateRequest {
  batch_id: string;
  run_id: string;
  index_in_batch: number;
  task_result: EpisodeTaskResult;
  failure_reason?: string | null;
  quality: EpisodeQuality;
  quality_source?: EpisodeQualitySource;
}

export interface EpisodePatchRequest {
  task_result?: EpisodeTaskResult;
  failure_reason?: string | null;
  quality?: EpisodeQuality;
  quality_source?: EpisodeQualitySource;
  review_status?: EpisodeReviewStatus;
}

// ---- System info (GET /api/v1/system) -----------------------------------

/** Filesystem usage of the runtime data dir (bytes). */
export interface SystemDisk {
  path: string;
  total_bytes: number;
  free_bytes: number;
}

/**
 * GET /api/v1/system: static CPU/GPU names joined with live, best-effort
 * utilization. Mirrors routers/system.py. The utilization fields are optional
 * and null whenever the host cannot measure them (older backend, no GPU, a
 * missing data dir, or — for cpu_percent — the very first sample), so the UI
 * shows an honest "—" rather than a fabricated number.
 */
export interface SystemInfo {
  cpu: { model: string | null; cores: number | null };
  gpu: string | null;
  cpu_percent?: number | null;
  disk?: SystemDisk | null;
  gpu_percent?: number | null;
}
