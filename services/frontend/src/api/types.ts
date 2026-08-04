// Domain types for the api_orchestrator REST/SSE contract.
// Source of truth: docs/specs/ja/api_orchestrator.md and config.md.

/**
 * Every state a capture row can hold (contract §3/§7, mirroring
 * `kairos_common.capture_sidecars.CaptureState`). The first five are what an
 * `object_manifest.json` may carry; the last three are reached only through the
 * deletion path — a manifest never says "deleted", because the deletion IS the
 * act of taking the manifest away. The row survives as a tombstone either way,
 * so "where did it go" stays answerable.
 */
export type CaptureState =
  | 'recording'
  | 'stopping'
  | 'completed'
  | 'interrupted'
  | 'failed'
  | 'delete_pending'
  | 'discarded'
  | 'deleted';

/** Capture states that reached an end (the bag, if any, is final). */
export const TERMINAL_CAPTURE_STATES = new Set<CaptureState>([
  'completed',
  'interrupted',
  'failed',
]);

/**
 * Where THIS installation's copy of a capture stands (§8). The two that carry
 * the most meaning are the ones the UI must never flatten into "gone":
 * `missing_unmanaged` is what an external `rm -rf` produces (§9-2 — a warning,
 * not a completed cleanup), and `corrupt` is a sidecar that exists but cannot
 * be read (§8 rule 4 — never reported as absent).
 */
export type ReplicaState =
  | 'present_unverified'
  | 'present_verified'
  | 'trashed'
  | 'absent_managed'
  | 'missing_unmanaged'
  | 'corrupt';

/** Whether per-file hashes have been sealed into the manifest (§11). */
export type DigestState = 'pending' | 'complete';

/**
 * The state the RECORDER reports through `/record/status`.
 *
 * This is the recorder's OWN vocabulary (`rosbag2_recorder.models.RunState`),
 * not the capture-row vocabulary, because `/api/v1/record/status` is a verbatim
 * proxy of the recorder. Two consequences that have bitten before:
 *
 *   * A fresh recorder sits in `created`, never `idle` — there is no `idle`
 *     state on the wire, so nothing may test for one.
 *   * The tombstone states (`delete_pending`/`discarded`/`deleted`) live in the
 *     database and never appear here; a recorder has no opinion about deletion.
 *
 * `armed` is the two-phase-start state: `POST /record/prepare` spawned the
 * recorder paused and subscribed, and no matching start has resumed it yet.
 */
export type RecordState =
  | 'created'
  | 'recording'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'armed';

/** Recorder states that mean a session is actually running — matching the
 *  recorder's own `_ACTIVE_STATES`. `armed` is deliberately NOT one of them:
 *  an armed session is subscribed but writing nothing. */
export const ACTIVE_RECORD_STATES = new Set<RecordState>(['recording', 'stopping']);

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
  /** The recorder mints the capture id at prepare time (§1), so a client can
   *  correlate the eventual capture without waiting for the start response. */
  capture_id?: string | null;
  state: 'armed';
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
  /** The most recent capture — it keeps pointing at the last one after a stop
   *  (never nulled), so it is NOT a liveness signal. Use `live_capture_ids`. */
  capture_id?: string | null;
  state: RecordState;
  /**
   * The definitive list of live captures (§10, rev.2.3: this name is final).
   * Non-empty for armed/recording/stopping — including `armed`, which no single
   * field can express — and `[]` otherwise.
   *
   * A response MISSING this array is an unreachable recorder, NOT an empty live
   * set (rev.2.4). `liveCaptureIds()` below is the only correct way to read it.
   */
  live_capture_ids?: string[];
  /** Actual capture start (recorder-stamped, post arming/resume) — the elapsed
   *  timer's baseline, available on the same poll that flips the UI to red. */
  started_at?: string | null;
  message_count?: number;
  bytes?: number;
  /** Present only while arming (state stays `recording` once resumed). */
  arming?: RecordArming | null;
  integrity?: RecordIntegrity;
  dropped_messages?: number | null;
  /** Free space on the RECORDER's data-dir filesystem — the robot's disk in
   *  the split deploy, which the console-side /system probe cannot see.
   *  Absent/null when the recorder cannot stat it (older recorder included). */
  disk_free_bytes?: number | null;
}

/**
 * The live capture set from a status response, or `null` when the recorder did
 * not answer with one.
 *
 * The distinction is the whole point (§10 rev.2.4): an absent array means the
 * recorder is unreachable and we know NOTHING about what is live, while `[]`
 * means it answered and nothing is. Collapsing the first into the second is how
 * a UI ends up telling an operator their running recording does not exist.
 */
export function liveCaptureIds(status: RecordStatus | undefined): string[] | null {
  if (!status || !Array.isArray(status.live_capture_ids)) return null;
  return status.live_capture_ids;
}

// ---- Captures ------------------------------------------------------------
// One capture carries both the recording facts and the operator's review, so
// what v1 split between a Run and an Episode is a single object here (§8).
// `/api/v1/runs` and `/api/v1/episodes` are retired with no compatibility
// alias — a capture_id is the only identity, and run_id is display text.

export interface TopicQos {
  reliability: string;
  durability: string;
  depth: number;
}

export interface CaptureTopic {
  name: string;
  type: string;
  qos?: TopicQos | null;
}

/** Structured reason attached to a capture (e.g. a failed start). */
export interface CaptureError {
  code: string;
  message: string;
}

export interface CaptureSplit {
  max_size_mb?: number | null;
  max_duration_s?: number | null;
}

/**
 * Where one installation's copy of a capture stands (§8).
 *
 * A capture can legitimately have review data with NO local replica: on a split
 * deploy the operator reviews before the bytes are pulled across. The UI must
 * render that as a normal state, never as an error.
 */
export interface Replica {
  instance_id: string;
  state: ReplicaState;
  path?: string | null;
  manifest_digest?: string | null;
  verified_at?: string | null;
  updated_at?: string | null;
}

/** A capture's membership in one dataset, as shown on the capture (§6). */
export interface DatasetMembership {
  membership_id: string;
  dataset_id: string;
  dataset_name?: string | null;
  /** Display-only number within the dataset; never reused after a removal. */
  display_index: number;
}

export type TaskResult = 'success' | 'failure';
export type Quality = 'good' | 'needs_review' | 'not_usable';
export type QualitySource = 'operator' | 'quick_check' | 'validator';
export type ReviewStatus = 'pending' | 'adopted' | 'excluded';
/** §7: one endpoint, two intents — they differ in the ledger kind and in what
 *  the UI is REQUIRED to say about reversibility (§12). */
export type DeleteKind = 'discard' | 'delete';

/** One recording, merged with the operator's review of it (`GET /captures`). */
export interface Capture {
  capture_id: string;
  /** `run_YYYYMMDD_HHMMSS` — DISPLAY ONLY (§1). Never an API key. */
  run_id?: string | null;
  source_instance_id?: string | null;
  state: CaptureState;
  operator?: string | null;
  task?: string | null;
  robot?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  topics?: CaptureTopic[];
  compression?: string;
  split?: CaptureSplit | null;
  error?: CaptureError | null;
  message_count?: number | null;
  bytes?: number | null;
  quick_check?: QuickCheck | null;

  // ---- review (record.json is authoritative; these mirror it, §4.1-4) ----
  task_result?: TaskResult | null;
  failure_reason?: string | null;
  quality?: Quality | null;
  quality_source?: QualitySource | null;
  review_status: ReviewStatus;
  /** 0 = never reviewed. Echoed back as `base_revision` to save an edit. */
  review_revision: number;
  batch_id?: string | null;
  index_in_batch?: number | null;

  // ---- tombstone (§7): the row survives the deletion ----
  deleted_at?: string | null;
  delete_kind?: DeleteKind | null;
  delete_reason?: string | null;

  // ---- archive (§6): the bytes left deliberately, to a recorded place ----
  archived_at?: string | null;
  archive_destination?: string | null;

  // ---- lease (§7.1): a job is touching objects/<id> right now ----
  lease_owner?: string | null;
  lease_expires_at?: string | null;

  created_at?: string | null;
  updated_at?: string | null;

  /** This installation's copy; null only for a capture we have never held. */
  replica?: Replica | null;
  /** `complete` once the digest job sealed per-file hashes into the manifest.
   *  Derived from the replica state, so "verified" is one fact (§9-4). */
  digest_state?: DigestState;
  memberships?: DatasetMembership[];
}

/** A capture plus its on-disk sidecars (`GET /api/v1/captures/{id}`). All the
 *  sidecar fields are best-effort and null when absent, so a capture whose
 *  files are gone still returns cleanly. */
/** A capture plus its on-disk sidecars (`GET /api/v1/captures/{id}`).
 *
 *  All of these are read best-effort from disk and are null when absent, so a
 *  capture whose files are gone still returns cleanly.
 *
 *  There is deliberately no `dataset_stats`: it pointed at the `dataset_export`
 *  pipeline, which §6 retired along with the physical dataset tree, so the
 *  field could only ever be null. A field structurally incapable of holding a
 *  value is worse than a missing one — it invites clients to keep checking it.
 *  The `signal_report` is likewise fetched through its job result, not here. */
export interface CaptureDetail extends Capture {
  manifest?: Record<string, unknown> | null;
  record?: Record<string, unknown> | null;
  validation?: Record<string, unknown> | null;
  loss?: { capture_id?: string; topics?: LossTopic[]; checked_at?: string } | null;
}

/** Query parameters accepted by `GET /api/v1/captures`. */
export interface CaptureListParams {
  state?: CaptureState;
  review_status?: ReviewStatus;
  task?: string;
  operator?: string;
  robot?: string;
  batch?: string;
  limit?: number;
  cursor?: string;
  /** Widen the default working set to include tombstones (§7). */
  include_deleted?: boolean;
}

/** Body of `PATCH /api/v1/captures/{id}/review` (§4.1).
 *
 *  `base_revision` is REQUIRED and is the whole point: the save is a
 *  compare-and-swap against the capture's current `review_revision`, so two
 *  terminals editing the same capture cannot silently overwrite each other.
 *  A mismatch is a 409 telling the client to reload — never a merge. */
export interface ReviewSaveRequest {
  base_revision: number;
  task_result?: TaskResult | null;
  failure_reason?: string | null;
  quality?: Quality | null;
  quality_source?: QualitySource | null;
  review_status?: ReviewStatus | null;
  batch_id?: string | null;
  index_in_batch?: number | null;
}

/** Body of `POST /api/v1/captures/{id}/delete` (§7). `reason` is REQUIRED for a
 *  discard: it is irreversible, and the ledger line is the only surviving
 *  explanation of why the data is gone. */
export interface CaptureDeleteRequest {
  kind: DeleteKind;
  reason?: string | null;
}

/** Body of `POST /api/v1/captures/{id}/archive` (§6). */
export interface CaptureArchiveRequest {
  destination: string;
  operator?: string | null;
  reason?: string | null;
}

/** One file as written to the archive destination — the same
 *  `{path, size, sha256}` shape as the manifest's file list (§3.2). */
export interface ArchivedFile {
  path: string;
  size: number;
  sha256: string;
}

/** Result of a completed capture archive.
 *
 *  `files` carries the per-file hashes rather than only a count because the
 *  source is deleted moments after this is computed: these digests and the
 *  matching ledger event are the only things left that can answer "is the
 *  archived copy still intact?". */
export interface CaptureArchiveResponse {
  capture_id: string;
  destination: string;
  bytes: number;
  file_count: number;
  files: ArchivedFile[];
  verified: boolean;
}

/**
 * `GET /api/v1/captures/{id}/archive/config` — whether this deployment may
 * archive at all, and to which roots. `enabled: false` (no KAIROS_ARCHIVE_ROOTS)
 * means the control is not rendered: never offer what can only ever fail.
 */
export interface ArchiveConfig {
  enabled: boolean;
  roots: string[];
}

/** One capture surfaced by `GET /api/v1/retention` as reclaimable (§10).
 *  Advisory ONLY: a candidate the operator may look at, never auto-deleted. */
export interface RetentionCandidate {
  capture_id: string;
  run_id?: string | null;
  started_at?: string | null;
  bytes?: number | null;
  state: CaptureState;
  review_status: ReviewStatus;
}

export interface RetentionInfo {
  days: number;
  candidates: RetentionCandidate[];
  total_bytes: number;
}

// ---- datasets (§6: rows + ledger events; no directory tree) --------------
// A dataset is a NAMED SET OF CAPTURES. Adding one moves nothing on disk, and
// the browsable <operator>/<task>/<dataset>/NNN shape is generated as symlinks
// under views/ by the server. There is no `dataset_dir` identity any more:
// dataset_id / membership_id / capture_id are the only stable keys.

/** `status` walks active → archiving → archived and never back (§6.x). The
 *  three archive fields are the durable face of the archive run — replayed
 *  from the ledger, so they survive a rebuild, unlike the in-flight progress
 *  served by `GET /datasets/{id}/archive`. */
export interface Dataset {
  dataset_id: string;
  name: string;
  operator?: string | null;
  task?: string | null;
  status: string;
  created_at?: string | null;
  member_count: number;
  archive_destination?: string | null;
  /** 'copy' sealed the set and kept the recordings here; 'move' removed them. */
  archive_mode?: string | null;
  archive_started_at?: string | null;
  archived_at?: string | null;
}

/** One capture's membership in a dataset. `display_index` is the number shown
 *  beside it INSIDE this dataset — display-only, and never reused after a
 *  removal (§6), so a retired number cannot make two takes share an identity. */
export interface DatasetMember {
  membership_id: string;
  dataset_id: string;
  capture_id: string;
  display_index: number;
  created_at?: string | null;
}

export interface DatasetDetail extends Dataset {
  members: DatasetMember[];
}

export interface DatasetListResponse {
  items: Dataset[];
}

export interface DatasetCreateRequest {
  name: string;
  operator?: string | null;
  task?: string | null;
}

/** `PATCH /datasets/{id}` — edit the three labels. Identity is dataset_id.
 *  Patch semantics: omitted keeps, explicit null clears (name never clears).
 *  Refused (409 dataset_not_active) once the dataset is no longer active. */
export interface DatasetUpdateRequest {
  name?: string;
  operator?: string | null;
  task?: string | null;
}

/** `POST /datasets/{id}/archive` (§6.x). `destination` is `<root>/<subpath>`
 *  from the archive allow-list; the server appends `<operator>/<task>/<name>`
 *  itself — the views shape has one owner. Omitted on resume: the run
 *  continues to the destination its ledger event froze. */
export interface DatasetArchiveRequest {
  destination?: string | null;
  /** The dataset's folder path under the destination root — operator-chosen,
   *  prefilled by the UI with the views shape `<operator>/<task>/<name>`.
   *  Omitted = the server derives that same default. */
  path?: string | null;
  /** 'move' (default): remove the sources after verifying — exclusive members
   *  only. 'copy': seal the set, sources untouched — legal for a combined
   *  dataset that shares recordings. Omit on resume. */
  mode?: 'copy' | 'move' | null;
  reason?: string | null;
}

/** One blocked member in a 409 `dataset_not_archivable` (its own reason), or
 *  one shared member in a 409 `dataset_member_shared`. */
export interface DatasetArchiveBlocker {
  capture_id: string;
  code?: string;
  message?: string;
  dataset_ids?: string[];
}

/** `GET /datasets/{id}/archive` — polled while a run executes. The durable
 *  fields survive a restart; `running`/`current_*`/`error` are the server
 *  process's memory and honestly reset. status `archiving` with
 *  `running: false` is the resumable state the UI renders as Resume. */
export interface DatasetArchiveProgress {
  dataset_id: string;
  status: string;
  destination?: string | null;
  mode?: string | null;
  member_total: number;
  members_done: number;
  running: boolean;
  current_capture_id?: string | null;
  current_bytes?: number | null;
  error?: { capture_id?: string; code?: string; message?: string } | null;
  archive_started_at?: string | null;
  archived_at?: string | null;
}

// ---- store health (§8 / §9-3) --------------------------------------------

/** A sidecar that exists but cannot be read (§8 rule 4). Never "missing". */
export interface CorruptEntry {
  capture_id?: string | null;
  path: string;
  reason: string;
}

/**
 * `GET /api/v1/store/health` — what the catalog knows about ITSELF.
 *
 * Exists because the two worst failures are both invisible in an ordinary
 * capture list: a rebuild that could not classify some captures (they have no
 * row, so they cannot appear), and a reconciler pass that saw so many copies
 * vanish at once that it refused to believe them (§9-3) — the catalog then
 * looks normal while the disk is not.
 */
export interface StoreHealth {
  instance_id: string;
  state: 'ok' | 'suspect';
  /** Set when the §9-3 threshold guard latched: the store stopped applying
   *  missing-transitions, the reaper and digests until an operator looks. */
  suspect_reason?: string | null;
  suspect_at?: string | null;
  /** False when objects/ .trash/ and .incoming/ are not on ONE filesystem (§2),
   *  which would make the trash rename an EXDEV copy instead of an atomic move.
   *  Deletion APIs are then withheld rather than silently degraded. */
  delete_available: boolean;
  delete_unavailable_reason?: string | null;
  rebuilt_at?: string | null;
  rebuild_summary?: Record<string, unknown> | null;
  /** Corrupt sidecars as of the most recent COMPLETE scan (§8 rule 4). ONE
   *  list, not one per pass: the startup rebuild and the periodic reconciler
   *  scan the same directory, so the newer observation replaces the older
   *  rather than being merged with it. */
  corrupt: CorruptEntry[];
  /** Which pass produced `corrupt`, and when. Without these, "no corruption"
   *  from a scan seconds ago is indistinguishable from the same answer taken at
   *  boot three days ago — which is why the UI must never claim an all-clear
   *  without saying when it was observed. */
  corrupt_source?: 'rebuild' | 'reconcile' | null;
  corrupt_observed_at?: string | null;
  warnings: string[];
  last_reconcile_at?: string | null;
  last_reconcile?: Record<string, unknown> | null;
}

/** `POST /api/v1/store/repair` — the operator's acknowledgement that clears
 *  SUSPECT. Refused (409 `volume_unidentified`) while the volume marker is
 *  unreadable: an approval that cannot name the volume is not an approval. */
export interface StoreRepairResponse {
  repaired: boolean;
  reconcile?: Record<string, unknown> | null;
}
/**
 * `video_check` job summary (dora_runner): an on-demand mp4 preview of one
 * camera topic. `file` is the path relative to data_dir (fetch it via
 * `${apiBase}/files/${file}`); `frames === 0` means nothing decodable was found.
 */
export interface VideoCheckSummary {
  capture_id?: string;
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
  /** True when served from the per-(capture, topic) cache instead of re-encoding. */
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
  capture_id?: string;
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
 * Fast pre-review quick-check settled at recording stop: a cheap two-layer
 * health read (live monitor at stop + MCAP summary) with a plain-language
 * verdict. Absent on captures recorded before the feature — the UI then shows
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
  /** Declared output contract, e.g. `report/<id>/<capture_id>/summary.json`. */
  outputs?: string[];
}

/** Body of `POST /api/v1/jobs` (§10.5). Every job is keyed by `capture_id`: it
 *  resolves its source as `objects/<capture_id>` and writes to
 *  `report/<pipeline>/<capture_id>/`. The v1 `dataset_dir` param is gone. */
export interface JobSubmitRequest {
  pipeline: string;
  capture_id: string;
  params?: Record<string, unknown>;
}

/**
 * A one-click validation preset (`GET /api/v1/validation/presets`). Static
 * fields come from the robot's `validation_presets.yaml`; `total`/`pending`/
 * `pending_capture_ids` are computed per request — the captures whose bytes are
 * on this host that this preset's pipeline has not validated yet.
 */
export interface ValidationPreset {
  id: string;
  name: string;
  description?: string;
  pipeline: string;
  params?: Record<string, unknown>;
  total: number;
  pending: number;
  pending_capture_ids: string[];
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
  capture_id: string;
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

/** The `record_status` SSE payload. The event NAME is unchanged; `capture_id`
 *  is additive (§10), so a client that keys on captures no longer has to map a
 *  display name back to an identity. */
export interface RecordStatusEvent {
  capture_id?: string | null;
  run_id: string | null;
  state: RecordState;
  started_at?: string | null;
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

// ---- Batches (Collect) ---------------------------------------------------
// A batch groups the captures recorded in one run of a task/condition. Under v2
// there is NO episodes resource: a capture IS the episode, so a batch's members
// are simply the captures carrying its `batch_id`, which the first review save
// stamps on (§4.1). `POST /api/v1/episodes` is retired; its two side effects
// (the monotone episodes_recorded counter and the split-deploy auto-pull) moved
// onto that first review save, which is what makes "reviewed" and "counted" one
// event instead of two that can disagree after a crash.

export type BatchStatus = 'active' | 'completed' | 'ended_early';

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
   *  "Batch N" shown in Collect and (as "MM/DD · #N") in Review/Datasets. */
  batch_seq?: number | null;
  /** Monotone count of captures ever reviewed into this batch. Incremented on
   *  the FIRST review save for a capture and never decremented, so "N / 30"
   *  stays truthful about what was captured even after a later exclude or
   *  delete. */
  episodes_recorded?: number;
}

/** Compact per-capture row inside a batch list item (`BatchSummary.episodes`). */
export interface BatchEpisodeSummary {
  index: number;
  capture_id: string;
  run_id?: string | null;
  batch_seq?: number | null;
  task_result?: TaskResult | null;
  quality?: Quality | null;
  review_status: ReviewStatus;
}

export interface BatchSummary extends Batch {
  episode_count: number;
  episodes: BatchEpisodeSummary[];
}

/** A batch plus its FULL captures (`GET /api/v1/batches/{id}`). */
export interface BatchDetail extends Batch {
  episode_count: number;
  captures: Capture[];
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
