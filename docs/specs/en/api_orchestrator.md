<!-- AUTO-GENERATED from docs/specs/ja/api_orchestrator.md. Do not edit by hand — edit the Japanese source and run /sync-docs. -->
# api_orchestrator specification

> Status: design finalized (v1). Based on `fig_const/apiオーケストラ.png`, with unspecified items fixed as recommended designs. Japanese is the source of truth (treat it as canonical). The English version `docs/specs/en/api_orchestrator.md` is an auto-generated mirror (do not edit it directly). **No authentication required.**

The **job management / state management / API hub** container. The single public API that the frontend talks to (**single entry point**. Aggregates REST / SSE control and state. As an exception, only WebRTC video and signaling are connected by the frontend directly to `webrtc_streamer`). `rosbag2_recorder` / `topic_monitor` / `webrtc_streamer` / `dora_runner` are internal services that the orchestrator directs and aggregates.

## Role

- Centralized management of the Run / job lifecycle.
- backend-driven config (settings and schemas provided by the backend; the `tabs` field is v1 legacy — Console v2's tabs are fixed in the frontend and not driven by it).
- A hub that directs each service and aggregates / notifies results.

## Input

- Operations from the frontend (recording Start/Stop, Run registration, Pipeline execution)
- live metrics from `topic_monitor` (SSE)
- job results / logs from `dora_runner` (stage3)

## Constituent components

- **Run Manager** / **Manifest Manager** / **Pipeline Registry** / **Result Aggregator** / **WebSocket・SSE Hub** (**Settings Manager** is a future slot, not implemented; config editing today is handled by `PUT /api/v1/config/recording`)
- A feature-based router structure (`recording` / `topics` / `runs` / `events` / `pipelines` …) is recommended (loosely coupled).

## Public API (`/api/v1`, no auth)

- Recording: `POST /api/v1/record/start`, `POST /api/v1/record/stop`, `GET /api/v1/record/status` (proxies to the recorder)
- Run: `GET /api/v1/runs` (cursor paging), `GET /api/v1/runs/{id}` (Console v2 Phase 2 **additively bundles an `episode` summary with each run**. See "Batch / Episode" below)
- Batch / Episode (**Console v2 Phase 2**. Persists Collect's progress and Review's decisions): `POST /api/v1/batches`, `PATCH /api/v1/batches/{id}`, `GET /api/v1/batches?status=`, `GET /api/v1/batches/{id}`, `POST /api/v1/episodes`, `PATCH /api/v1/episodes/{id}` (see "Batch / Episode" below)
- Topic: `GET /api/v1/topics` (list. **The source is a proxy of `topic_monitor`'s `GET /topics` discovery**: `name` / `type` / `publisher_count` / `subscriber_count` / `qos` / `last_seen`), `GET /api/v1/topics/status` (live metrics from the monitor)
- Events: `GET /api/v1/events` (**SSE aggregation**. Contract below)
- Pipeline / Job (stage3. Details in [dora_runner](dora_runner.md)): `GET /api/v1/pipelines`, `POST /api/v1/jobs`, `GET /api/v1/jobs/{id}/status`, `GET /api/v1/jobs/{id}/result`, `POST /api/v1/jobs/{id}/cancel`
- Validation templates: `GET/POST /api/v1/validation/templates`, `POST /api/v1/validation/templates/generate` (generate a draft from a run)
- One-click validation presets: `GET /api/v1/validation/presets` (config-defined presets + their not-yet-validated runs)
- Settings: `GET /api/v1/config` (frontend runtime settings: endpoints / tabs / defaults (including `ros_domain_id`) / stream / schemas). [`GET/POST /api/v1/settings` is **not implemented** (future); `PUT /api/v1/config/recording` below is currently the entry point for config editing]
- Recording config (full edit): `GET /api/v1/config/recording` → `{ config: <RecordingConfig dump>|null, path }`, `PUT /api/v1/config/recording` (body `{ config }`. See "Full editing of recording config" below)
- Settings catalog: `GET /api/v1/config/options`, `POST /api/v1/config/select` (per-category choices such as validation templates, and the current selection)
- System info: `GET /api/v1/system` → `{ cpu: { model, cores }, gpu, cpu_percent, disk, gpu_percent }` (read-only introspection of the host. Always `200`)
  - `cpu` / `gpu`: static information (CPU model name and logical core count from `/proc/cpuinfo`, GPU name from `nvidia-smi`. Each field is `null` when unobtainable)
  - `cpu_percent`: host-wide CPU utilization `[0, 100]` (computed by diffing two snapshots of the aggregated `cpu` line of `/proc/stat` = true busy%, not a load average). `null` on the first sample (no diff baseline yet) or when `/proc/stat` is unreadable
  - `disk`: `{ path, total_bytes, free_bytes }` of the filesystem holding the recording-data directory (`shutil.disk_usage`. Prefers the `data_dir` the app knows; falls back to `/data`. `null` when neither exists)
  - `gpu_percent`: GPU utilization `[0, 100]` (`nvidia-smi --query-gpu=utilization.gpu`). `null` when there is no GPU or `nvidia-smi` is unobtainable (never fabricate a value)
  - `cpu_percent` / `disk` / `gpu_percent` change over time, so they are cached for ~2 seconds (cheap even under SSE-like polling). The `nvidia-smi` probe runs in a worker thread and does not block the event loop
- File serving: `GET /api/v1/files/{path}` — serves a file by a **relative path** from `data_dir` (traversal guard: only under `data_dir`; otherwise / absent is `404`). Used to retrieve `video_check` mp4 previews
- Datasets: `GET /api/v1/datasets` (a list scanned from `data/<operator>/<task>/<NNN>/dataset.json`. Reads only under `data_dir`), `GET /api/v1/datasets/{operator}/{task}/{index}` (**detail of an exported dataset**. See "Dataset export" below), `DELETE /api/v1/datasets/{operator}/{task}/{index}` (**delete an exported dataset**. See the same section), `POST /api/v1/datasets/export` (body `{ run_id }`), `POST /api/v1/datasets/export-all` (**bulk** export of completed runs in `recorded/`)
- `GET /healthz` / `GET /readyz` (also returns connectivity of `components: { recorder, monitor, streamer }`)
- `GET /openapi.json` (OpenAPI, published automatically; usable for client generation — the current frontend uses a hand-written typed client)

## Run lifecycle (centrally managed by the orchestrator)

1. `POST /api/v1/record/start` → the orchestrator **assigns a `run_id`** and creates a run in SQLite (`state=created`).
2. Calls the recorder's `POST /record/start` (passing `run_id`). On success, `state=recording`; on failure, the **run row is kept and updated to `state=failed`** (recording the reason. The DB row is not deleted).
3. Immediately after a successful start, fetches the recorder's `GET /record/metadata` and **syncs the finalized topics / type / QoS (including the result of `"all"` expansion) to the run row**. On fetch failure, keeps it `recording`, records the reason in `error`, and retries.
4. `POST /api/v1/record/stop` → recorder stop → re-syncs the final metadata (`message_count` / `bytes` / `ended_at` / topics) and sets `state=completed`. If it completes while still unable to sync, it is set to `state=completed` and the sync failure is left in `error` (subject to reconciliation).
5. **Reconciliation on restart**: at startup, reconciles `recording` / `stopping` runs against the recorder's `GET /record/status`, and if no actual entity exists, updates to `state=interrupted`.

- The `run_id` is owned by the orchestrator and passed to the recorder. **SQLite is the single source of truth**; the recorder's `manifest.json` is for auditing.
- A run row's `topics` / type / QoS come from the recorder's metadata (the orchestrator syncs them at the timings above).
- The run state enum follows the shared [config](config.md).
- **operator / task at start**: when empty, `unknown_operator` / `unknown_task` are the defaults (so that the dataset destination `data/<operator>/<task>` is always keyable, eliminating null components).
- **`record_status` SSE**: emits a `record_status` event on each state transition of record start / stop (SSE contract below).
- **`GET /api/v1/runs/{id}` returns RunDetail**: in addition to the run row, it best-effort includes on-disk sidecars — `manifest` (the recorder's `manifest.json`) / `validation` (the `fast_validation` report) / `dataset_stats` (the `dataset_export` report) / `loss` (the `loss_report` report). If a file is absent, it is `null` (returns cleanly even for orphan runs).

## Batch / Episode (Console v2 Phase 2)

**Persists** Collect's Batch/Episode progress, task results, and quality decisions in the orchestrator, so Review can show real data independent of the terminal (replacing the earlier in-browser bridge `episodeBridge`). **The existing runs / jobs are untouched.** An episode is a separate table holding a reference to a run; the recording path (record/start → stop → MCAP) is unchanged = no impact on recording safety.

- **Data model** (2 tables added to the orchestrator's existing SQLite):
  - `batches`: `batch_id` (`batch_YYYYMMDD_HHMMSS`) / `robot` / `project` / `task` / `condition` / `operator` / `target_episodes` (default 30) / `status` (`active` | `completed` | `ended_early`) / `ended_reason?` / `created_at` / `ended_at?` / `episodes_recorded` (**monotone counter of recorded episodes. Default 0**) / `batch_seq` (**human-readable batch number per (robot, local date). Nullable**). `project` is a string derived from a Plan (**modelling Plans themselves is deferred to Phase 2.5**).
    - `episodes_recorded` is incremented on each `POST /api/v1/episodes` and **never decremented, even by the run-delete CASCADE** (`episode_count` is the live count and drops on deletion, but Collect's "N / 30"-style displays treat the number of takes as canonical, so this monotone value is used). Added to existing DBs by an additive migration and backfilled with the current episode count.
    - `batch_seq` is **assigned at batch creation (= lazily, at the first recording)**: `1 + MAX(batch_seq)` (over existing batches of the same robot and same local date; the UTC `created_at` is converted to a local date via `date(created_at,'localtime')` for the match). It **resets to 1 each morning by local date, independently per robot**, and becomes the single human-readable number across Collect/Review/Datasets (Collect = "Batch N", Review/Datasets = "MM/DD · #N"; the date is derived from `created_at` = no new column). An empty batch has no row = consumes no number. Numbering is race-safe since read→insert happens in one transaction under the store lock. Added to existing DBs by an additive migration and backfilled per (robot, local date) group in `created_at` ascending order.
  - `episodes`: `episode_id` (`ep_<uuid>`) / `batch_id` / `run_id` (**UNIQUE** = 1 episode = 1 run) / `index_in_batch` / `task_result` (`success` | `failure`) / `failure_reason?` / `quality` (`good` | `needs_review` | `not_usable`) / `quality_source` (`operator` | `quick_check` | `validator`. Default `operator`) / `review_status` (`pending` | `adopted` | `excluded`. Default `pending`) / `created_at` / `updated_at`.
  - FKs are enforced in code (no reliance on SQLite's FK pragma). On `DELETE /api/v1/runs/{id}`, the corresponding episode is **cascade-deleted in code**.
- **Endpoints**:
  - `POST /api/v1/batches` — start a batch. Body `{ project, task, condition?, operator?, robot?, target_episodes=30 }` → `201` (when `robot` is omitted, it is filled in with the **active robot**). On a same-second collision, `batch_id` is re-assigned with a suffix.
  - `PATCH /api/v1/batches/{id}` — early termination (`status` / `ended_reason`) and `condition` changes. **`ended_at` is stamped exactly once when a terminal status (`completed` / `ended_early`) is reached.** Inconsistent transitions are tolerated loosely (no hard rejection). Absent is `404`.
  - `GET /api/v1/batches?status=` — batch list (**newest first**). Each element bundles `batch_seq`, `episode_count` (live count), `episodes_recorded` (monotone counter), and a **compact episodes summary** (`index` / `run_id` / `batch_seq` / `task_result` / `quality` / `review_status`) (used to restore the active batch on reload; Collect's counters reference `episodes_recorded`).
  - `GET /api/v1/batches/{id}` — the whole batch + **episodes (full)**. Absent is `404`.
  - `POST /api/v1/episodes` — on Collect Save. Body `{ batch_id, run_id, index_in_batch, task_result, failure_reason?, quality, quality_source='operator' }` → `201`. Unknown batch / run is `404`; a run that already has an episode is **`409`** (`episode_exists`).
  - `PATCH /api/v1/episodes/{id}` — Review's Adopt/Exclude (`review_status`) and quality/result overrides. Absent is `404`. `updated_at` is refreshed on every write.
- **JOIN into runs**: `GET /api/v1/runs` / `GET /api/v1/runs/{id}` **additively bundle** an `episode` summary (`episode_id` / `batch_id` / `batch_seq` / `index_in_batch` / `task_result` / `failure_reason` / `quality` / `review_status`) with each run (`null` when absent). Since `batch_seq` lives on the batch rather than the episode row, the join bulk-resolves `batch_id → batch_seq` and attaches it (so Review/Datasets can show the number without a second round trip). Existing fields are unchanged. The list avoids N+1 via a bulk batch fetch.
- **SSE**: the existing `record_status` / `resync` suffice, so **no new events are added** (Phase 2b if needed).
- **Phase 2.5 TBD**: of the UX spec's Session > Batch > Episode, **Session is not built this time** (to be decided from operational experience). Modelling Plans (Projects/Tasks/Conditions) in the DB and saving edits from Settings are also Phase 2.5.

## Full editing of recording config (`GET/PUT /api/v1/config/recording`)

Edit and persist the entire `RECORDING_CONFIG` from the UI (Settings tab).

- `GET` — returns the live recording config (the current value on `app.state`, reflecting the previous PUT without a restart) and its file path as `{ config, path }` (`config: null` when not loaded).
- `PUT` — body `{ config }`. Type-validates `config` against `RecordingConfig` ([config](config.md)); on failure, **`422`** (returns the violating fields in `details.errors`). On success, **atomically writes the YAML to the `RECORDING_CONFIG` file** (temp + `os.replace`. The write target is always the settings file; the path from the request is not used), and **hot-swaps the in-memory settings**.
- Timing of application: `GET /api/v1/config` and the **`default_topics` (including robot_name, etc.) of the next recording are reflected immediately**. The recorder's QoS / the monitor's expected_hz and allowlist are applied at each service's **next restart** (the UI also indicates this).

## Job execution (`POST /api/v1/jobs`, proxied to `dora_runner`)

- `dataset_export`: if the target run is unknown, **`404`**; if still recording / stopping (`created` / `recording` / `stopping`), **`409`** (does not export a bag mid-write).
- `fast_validation`: **resolves the `params.template` id (the catalog file stem, e.g. `airoa_hsr`) to a full template via the Config catalog** before forwarding to `dora_runner` (since the dora_runner template store starts empty, a bare id would be a 404). If the id is empty / absent, falls back to the current selection (active). If it is already a dict (full template), passes it through as is.

## Dataset export (`POST /api/v1/datasets/export(-all)`)

An operation that **moves a recording from the canonical staging (`recorded/`) to the dataset tree (`data/<operator>/<task>/<NNN>`)**. Rather than a direct call to `POST /jobs`, the orchestrator waits for the `dataset_export` job to complete and takes care of **the run lifecycle as well**.

- `POST /api/v1/datasets/export` (body `{ run_id }`): if the target is not `completed`, **`409`**; if `recorded/<run_id>` is absent, **`409`** (already exported, etc.). Runs `dataset_export` (the move) to completion, and **deletes the run row only on success** (since it has been moved, also cleans up the `recorded/` directory and sibling files). **The run-keyed report sidecars (`data/report/*/<run_id>`: validation / loss / the video_check mp4 cache) are deliberately kept** — so the dataset detail view can keep showing them after export (an explicit `DELETE /api/v1/runs/{id}` still cleans them up as before). On failure (`502`) / timeout (`504`), the run is left in `recorded/` and in the list.
- `POST /api/v1/datasets/export-all`: exports **all** completed runs whose files remain in `recorded/`. A single failure does not stop the batch; returns `{ exported: [...], failed: [{ run_id, error }], total }`.
- **Labels survive the export (`episode.json`)** — Console v2 Phase 2: since deleting the run row cascades away the episode, the export reads the run's episode (if any) and its batch **before deleting the run row** and writes `episode.json` next to `dataset.json` (atomic tmp+rename write). Contents = `episode_id` / `batch_id` / `batch_seq` / `index_in_batch` / `task_result` / `failure_reason?` / `quality` / `quality_source` / `review_status` + the batch context `batch: { batch_id, batch_seq, project, task, condition, operator, robot }` + `exported_at`. **Without this, failure-labelled data would be exported as unlabelled.** A run with no episode writes no `episode.json` (no empty file either). The single and export-all paths go through the same logic.
- As a result, **exported recordings disappear from the recordings list (the Review tab)** (provenance is saved to `<NNN>/dataset.json`). `GET /api/v1/datasets` lists operator › task › NNN. Each list row bundles a **lightweight subset** of `episode.json` (`task_result` / `quality` / `review_status` / `batch_seq` / `index_in_batch`; `null` when absent) for card display (read per row, like `dataset.json`).
- **`GET /api/v1/datasets/{operator}/{task}/{index}` returns the post-export equivalent of RunDetail** (DatasetDetail): on top of `dataset.json` (provenance · `files` / `bytes` / `message_count`), it best-effort bundles the moved `session.json` (state / started_at / ended_at), `manifest.json` (topics with name / type / QoS; falls back to the name-only lists in session / dataset.json when absent), **`episode.json` (bundled as the `episode` field; `null` when absent)**, plus the run-keyed reports that survived the export (`validation` / `loss`). The response's `path` (the relative `<operator>/<task>/<index>`) can be used as-is as `params.dataset_dir` when running `video_check` / `loss_report` jobs after export. Path components must be plain single directory names (traversal and the reserved names `recorded`/`report`/`datasets` are `400`); a missing directory or `dataset.json` is `404`.
- **`DELETE /api/v1/datasets/{operator}/{task}/{index}` is the post-export equivalent of `DELETE /runs/{id}`** (`204`): it removes the dataset directory (with its sidecars such as `episode.json`), cleans up the now-empty `<task>` / `<operator>` parent directories, and **also deletes the run-keyed report sidecars (`data/report/*/<run_id>`) deliberately kept at export, since they become orphans here** (they are kept if a run row with the same run_id still exists). The path rules are the same as the detail view (an unsafe component or a reserved name is `400`; a missing directory or `dataset.json` is `404` — a directory without `dataset.json` is never a delete target). A failed removal is `500` (`dataset_delete_failed`).

## SSE event contract (`GET /api/v1/events`)

- Format: `id:` (monotonically increasing integer) / `event:` (kind) / `data:` (JSON).
- Kinds and payloads:
  - `record_status`: `{ run_id, state, message_count, bytes }`
  - `metrics`: `topic_monitor`'s periodic snapshot (the output schema of [topic_monitor](topic_monitor.md))
  - `alert`: `{ topic, metric, level, value, threshold }`
  - `job`: `{ job_id, run_id, pipeline, state, progress }`
- Reconnection: the client sends `Last-Event-ID`. The server retains recent events in a ring buffer (default 1000 events / 5 minutes) and resends the unsent portion. If out of range, it sends `event: resync` and the client re-fetches the whole thing.

## Key schemas (excerpt, OpenAPI generation targets / pydantic)

- settings (`GET/POST /api/v1/settings`. **Not implemented, future slot**): `{ defaults: { encoding: "vp8"|"h264", expected_hz: { <pattern>: number } }, alerts: [ { topic, metric, op, threshold, cooldown_s, clear_after_s } ], retention_days: int, max_record_bytes: int }`. The original design intended this to override / supplement `RECORDING_CONFIG` at runtime and take effect from the next recording session, but today `PUT /api/v1/config/recording` (below; atomic write + hot-swap) substitutes for it.
- Validation templates:
  - `GET /api/v1/validation/templates` → `{ items: [ { name, version, required_topics: [ { name, type?: string } ] } ], next_cursor }`
  - `POST /api/v1/validation/templates` body = `{ name, version, required_topics: [ { name, type? } ] }` → `201` same shape
  - `POST /api/v1/validation/templates/generate` body = `{ run_id }` → `{ name, version, required_topics: [ ... ] }` (a draft)
- One-click validation presets:
  - `GET /api/v1/validation/presets` → `{ items: [ { id, name, description, pipeline, params, total, pending, pending_run_ids: [ run_id ] } ] }`. The static fields (`id` / `name` / `description` / `pipeline` / `params`) come from the robot's `validation_presets.yaml` ([config](config.md)). The dynamic fields are computed per request = the completed recordings (runs still in `recorded/`) for which **that pipeline's `report/<pipeline>/<run_id>/summary.json` does not exist yet** (`pending_run_ids`). The UI runs them in one click (`POST /api/v1/jobs` per run). Read-only (does not change state).
- run (`GET /api/v1/runs/{id}` = RunDetail): `{ run_id, state, started_at, ended_at?: string|null, operator?, task?, topics: [ { name, type, qos } ], compression, split?: object|null, error?: { code, message }|null, episode?: object|null, manifest?: object|null, validation?: object|null, dataset_stats?: object|null, loss?: object|null }` (`episode` is the Phase 2 JOIN. The last 4 come from on-disk sidecars. Each is `null` when absent).
- batch (an element of `GET /api/v1/batches` = BatchSummary): `{ batch_id, robot?, project, task, condition?, operator?, target_episodes, status, ended_reason?, created_at, ended_at?, episodes_recorded, batch_seq?, episode_count, episodes: [ { index, run_id, batch_seq?, task_result, quality, review_status } ] }`. In `GET /api/v1/batches/{id}` (BatchDetail), `episodes` is the full episode array.
- episode (`POST/PATCH /api/v1/episodes`): `{ episode_id, batch_id, run_id, index_in_batch, task_result, failure_reason?, quality, quality_source, review_status, created_at, updated_at }`.
- job (`GET /api/v1/jobs/{id}/status`): `{ job_id, run_id, pipeline, state, progress, logs_tail }` ([dora_runner](dora_runner.md)).

## Framework / persistence

- **FastAPI + uvicorn** (recommended. Auto-publishes OpenAPI).
- Put heavy processing (validation / conversion, stage3) on an **asynchronous job queue**, decoupled from request/response. Progress is notified via SSE.
- Persistence: **runs / jobs are canonical in SQLite**, the file manifest is for auditing. Avoid accidents where only one side is updated (the settings store is not implemented; recording config is persisted atomically to the config file via `PUT /api/v1/config/recording`).
- Internal service calls use a timeout (default `3s`) + 1 retry. Failures are reflected in `status` / `events` (`503`).

## Errors / conventions / network

- The common API conventions (status codes `400`/`404`/`409`/`422`/`503`/`507`, error format, paging, enums, types / timestamps) follow [config](config.md).
- The bind is `BIND_HOST` (default `0.0.0.0`, **allows LAN exposure**. Assumes a trusted LAN, no auth). CORS is `CORS_ORIGINS` (when exposed on the LAN, add the origin of the relevant host).

## Design points

- **backend-driven**: the orchestrator provides pipeline definitions, form schemas, and runtime settings (the frontend does not hardcode them; only the tab structure became frontend-fixed with Console v2).
- Video (WebRTC) is connected by the frontend directly to `webrtc_streamer`. Everything else is aggregated by the orchestrator.
- Shared configuration is in [config](config.md).
