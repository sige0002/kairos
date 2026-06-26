<!-- AUTO-GENERATED from docs/specs/ja/api_orchestrator.md. Do not edit by hand — edit the Japanese source and run /sync-docs. -->
# api_orchestrator specification

> Status: design finalized (v1). Based on `fig_const/apiオーケストラ.png`, with unspecified items fixed as recommended designs. Japanese is the source of truth (treat it as canonical). The English version `docs/specs/en/api_orchestrator.md` is an auto-generated mirror (do not edit it directly). **No authentication required.**

The **job management / state management / API hub** container. The single public API that the frontend talks to (**single entry point**. Aggregates REST / SSE control and state. As an exception, only WebRTC video and signaling are connected by the frontend directly to `webrtc_streamer`). `rosbag2_recorder` / `topic_monitor` / `webrtc_streamer` / `dora_runner` are internal services that the orchestrator directs and aggregates.

## Role

- Centralized management of the Run / job lifecycle.
- backend-driven config (settings, schemas, and tab structure provided by the backend).
- A hub that directs each service and aggregates / notifies results.

## Input

- Operations from the frontend (recording Start/Stop, Run registration, Pipeline execution)
- live metrics from `topic_monitor` (SSE)
- job results / logs from `dora_runner` (stage3)

## Constituent components

- **Run Manager** / **Manifest Manager** / **Pipeline Registry** / **Result Aggregator** / **WebSocket・SSE Hub** / **Settings Manager**
- A feature-based router structure (`recording` / `topics` / `runs` / `events` / `pipelines` …) is recommended (following `../rosbag-view`, loosely coupled).

## Public API (`/api/v1`, no auth)

- Recording: `POST /api/v1/record/start`, `POST /api/v1/record/stop`, `GET /api/v1/record/status` (proxies to the recorder)
- Run: `GET /api/v1/runs` (cursor paging), `GET /api/v1/runs/{id}`
- Topic: `GET /api/v1/topics` (list. **The source is a proxy of `topic_monitor`'s `GET /topics` discovery**: `name` / `type` / `publisher_count` / `subscriber_count` / `qos` / `last_seen`), `GET /api/v1/topics/status` (live metrics from the monitor)
- Events: `GET /api/v1/events` (**SSE aggregation**. Contract below)
- Pipeline / Job (stage3. Details in [dora_runner](dora_runner.md)): `GET /api/v1/pipelines`, `POST /api/v1/jobs`, `GET /api/v1/jobs/{id}/status`, `GET /api/v1/jobs/{id}/result`, `POST /api/v1/jobs/{id}/cancel`
- Validation templates: `GET/POST /api/v1/validation/templates`, `POST /api/v1/validation/templates/generate` (generate a draft from a run)
- Settings: `GET /api/v1/config` (frontend runtime settings: endpoints / tabs / defaults (including `ros_domain_id`) / stream / schemas), `GET/POST /api/v1/settings`
- Recording config (full edit): `GET /api/v1/config/recording` → `{ config: <RecordingConfig dump>|null, path }`, `PUT /api/v1/config/recording` (body `{ config }`. See "Full editing of recording config" below)
- Settings catalog: `GET /api/v1/config/options`, `POST /api/v1/config/select` (per-category choices such as validation templates, and the current selection)
- System info: `GET /api/v1/system` → `{ cpu: { model, cores }, gpu }` (read-only introspection of the host. When `nvidia-smi` is absent, `gpu: null`. Always `200`)
- File serving: `GET /api/v1/files/{path}` — serves a file by a **relative path** from `data_dir` (traversal guard: only under `data_dir`; otherwise / absent is `404`). Used to retrieve `video_check` mp4 previews
- Datasets: `GET /api/v1/datasets` (a list scanned from `data/<operator>/<task>/<NNN>/dataset.json`. Reads only under `data_dir`), `POST /api/v1/datasets/export` (body `{ run_id }`. See "Dataset export" below), `POST /api/v1/datasets/export-all` (**bulk** export of completed runs in `recorded/`)
- `GET /healthz` / `GET /readyz` (also returns connectivity of `components: { recorder, monitor, streamer }`)
- `GET /openapi.json` (OpenAPI. The frontend auto-generates a client with Orval)

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

## Full editing of recording config (`GET/PUT /api/v1/config/recording`)

Edit and persist the entire `RECORDING_CONFIG` from the UI (Config tab).

- `GET` — returns the live recording config (the current value on `app.state`, reflecting the previous PUT without a restart) and its file path as `{ config, path }` (`config: null` when not loaded).
- `PUT` — body `{ config }`. Type-validates `config` against `RecordingConfig` ([config](config.md)); on failure, **`422`** (returns the violating fields in `details.errors`). On success, **atomically writes the YAML to the `RECORDING_CONFIG` file** (temp + `os.replace`. The write target is always the settings file; the path from the request is not used), and **hot-swaps the in-memory settings**.
- Timing of application: `GET /api/v1/config` and the **`default_topics` (including robot_name, etc.) of the next recording are reflected immediately**. The recorder's QoS / the monitor's expected_hz and allowlist are applied at each service's **next restart** (the UI also indicates this).

## Job execution (`POST /api/v1/jobs`, proxied to `dora_runner`)

- `dataset_export`: if the target run is unknown, **`404`**; if still recording / stopping (`created` / `recording` / `stopping`), **`409`** (does not export a bag mid-write).
- `fast_validation`: **resolves the `params.template` id (the catalog file stem, e.g. `airoa_hsr`) to a full template via the Config catalog** before forwarding to `dora_runner` (since the dora_runner template store starts empty, a bare id would be a 404). If the id is empty / absent, falls back to the current selection (active). If it is already a dict (full template), passes it through as is.

## Dataset export (`POST /api/v1/datasets/export(-all)`)

An operation that **moves a recording from the canonical staging (`recorded/`) to the dataset tree (`data/<operator>/<task>/<NNN>`)**. Rather than a direct call to `POST /jobs`, the orchestrator waits for the `dataset_export` job to complete and takes care of **the run lifecycle as well**.

- `POST /api/v1/datasets/export` (body `{ run_id }`): if the target is not `completed`, **`409`**; if `recorded/<run_id>` is absent, **`409`** (already exported, etc.). Runs `dataset_export` (the move) to completion, and **deletes the run row only on success** (since it has been moved, also cleans up the `recorded/` directory, sibling files, and report sidecars). On failure (`502`) / timeout (`504`), the run is left in `recorded/` and in the list.
- `POST /api/v1/datasets/export-all`: exports **all** completed runs whose files remain in `recorded/`. A single failure does not stop the batch; returns `{ exported: [...], failed: [{ run_id, error }], total }`.
- As a result, **exported recordings disappear from the Recordings list** (provenance is saved to `<NNN>/dataset.json`). `GET /api/v1/datasets` lists operator › task › NNN.

## SSE event contract (`GET /api/v1/events`)

- Format: `id:` (monotonically increasing integer) / `event:` (kind) / `data:` (JSON).
- Kinds and payloads:
  - `record_status`: `{ run_id, state, message_count, bytes }`
  - `metrics`: `topic_monitor`'s periodic snapshot (the output schema of [topic_monitor](topic_monitor.md))
  - `alert`: `{ topic, metric, level, value, threshold }`
  - `job`: `{ job_id, run_id, pipeline, state, progress }`
- Reconnection: the client sends `Last-Event-ID`. The server retains recent events in a ring buffer (default 1000 events / 5 minutes) and resends the unsent portion. If out of range, it sends `event: resync` and the client re-fetches the whole thing.

## Key schemas (excerpt, OpenAPI generation targets / pydantic)

- settings (`GET/POST /api/v1/settings`): `{ defaults: { encoding: "vp8"|"h264", expected_hz: { <pattern>: number } }, alerts: [ { topic, metric, op, threshold, cooldown_s, clear_after_s } ], retention_days: int, max_record_bytes: int }`. POST is a partial update. settings overrides / supplements `RECORDING_CONFIG` at runtime, and is **reflected from the next recording session / the monitor's re-subscription** (it does not apply retroactively to a recording in progress).
- Validation templates:
  - `GET /api/v1/validation/templates` → `{ items: [ { name, version, required_topics: [ { name, type?: string } ] } ], next_cursor }`
  - `POST /api/v1/validation/templates` body = `{ name, version, required_topics: [ { name, type? } ] }` → `201` same shape
  - `POST /api/v1/validation/templates/generate` body = `{ run_id }` → `{ name, version, required_topics: [ ... ] }` (a draft)
- run (`GET /api/v1/runs/{id}` = RunDetail): `{ run_id, state, started_at, ended_at?: string|null, operator?, task?, topics: [ { name, type, qos } ], compression, split?: object|null, error?: { code, message }|null, manifest?: object|null, validation?: object|null, dataset_stats?: object|null, loss?: object|null }` (the last 4 come from on-disk sidecars. `null` when absent).
- job (`GET /api/v1/jobs/{id}/status`): `{ job_id, run_id, pipeline, state, progress, logs_tail }` ([dora_runner](dora_runner.md)).

## Framework / persistence

- **FastAPI + uvicorn** (recommended. Auto-publishes OpenAPI).
- Put heavy processing (validation / conversion, stage3) on an **asynchronous job queue**, decoupled from request/response. Progress is notified via SSE.
- Persistence: **runs / jobs / settings are canonical in SQLite**, the file manifest is for auditing. Avoid accidents where only one side is updated.
- Internal service calls use a timeout (default `3s`) + 1 retry. Failures are reflected in `status` / `events` (`503`).

## Errors / conventions / network

- The common API conventions (status codes `400`/`404`/`409`/`422`/`503`/`507`, error format, paging, enums, types / timestamps) follow [config](config.md).
- The bind is `BIND_HOST` (default `0.0.0.0`, **allows LAN exposure**. Assumes a trusted LAN, no auth). CORS is `CORS_ORIGINS` (when exposed on the LAN, add the origin of the relevant host).

## Design points

- **backend-driven**: the orchestrator provides pipeline definitions, form schemas, and tab structure (the frontend does not hardcode them).
- Video (WebRTC) is connected by the frontend directly to `webrtc_streamer`. Everything else is aggregated by the orchestrator.
- Shared configuration is in [config](config.md).
