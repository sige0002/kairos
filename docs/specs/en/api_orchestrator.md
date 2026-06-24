<!-- AUTO-GENERATED from docs/specs/ja/api_orchestrator.md. Do not edit by hand — edit the Japanese source and run /sync-docs. -->

# api_orchestrator Specification

> Status: design finalized (v1). Based on `fig_const/apiオーケストラ.png`, with unstated items finalized as the recommended design. Japanese is the source of truth (it governs). The English version `docs/specs/en/api_orchestrator.md` is an auto-generated mirror (do not edit it directly). **No authentication required.**

The **job management / state management / API hub** container. The single public API the frontend talks to (**single entry point**. Aggregates REST / SSE control and state. As an exception, only WebRTC video and signaling are connected directly by the frontend to `webrtc_streamer`). `rosbag2_recorder` / `topic_monitor` / `webrtc_streamer` / `dora_runner` are internal services that the orchestrator instructs and aggregates.

## Role

- Centralized management of the Run / job lifecycle.
- backend-driven config (the backend provides settings, schemas, and tab layout).
- A hub for instructing each service and for aggregating / notifying results.

## Input

- Operations from the frontend (record Start/Stop, Run registration, Pipeline execution)
- live metrics from `topic_monitor` (SSE)
- job results / logs from `dora_runner` (stage3)

## Components

- **Run Manager** / **Manifest Manager** / **Pipeline Registry** / **Result Aggregator** / **WebSocket/SSE Hub** / **Settings Manager**
- A feature-based router layout (`recording` / `topics` / `runs` / `events` / `pipelines` …) is recommended (following `../rosbag-view`, loosely coupled).

## Public API (`/api/v1`, unauthenticated)

- Recording: `POST /api/v1/record/start`, `POST /api/v1/record/stop`, `GET /api/v1/record/status` (proxied to the recorder)
- Run: `GET /api/v1/runs` (cursor paging), `GET /api/v1/runs/{id}`
- Topic: `GET /api/v1/topics` (list. **The source is a proxy of `topic_monitor`'s `GET /topics` discovery**: `name` / `type` / `publisher_count` / `subscriber_count` / `qos` / `last_seen`), `GET /api/v1/topics/status` (live metrics originating from the monitor)
- Events: `GET /api/v1/events` (**SSE aggregation**. Contract below)
- Pipeline / Job (stage3. Details in [dora_runner](dora_runner.md)): `GET /api/v1/pipelines`, `POST /api/v1/jobs`, `GET /api/v1/jobs/{id}/status`, `GET /api/v1/jobs/{id}/result`, `POST /api/v1/jobs/{id}/cancel`
- Validation templates: `GET/POST /api/v1/validation/templates`, `POST /api/v1/validation/templates/generate` (generate a template from a run)
- Settings: `GET /api/v1/config` (frontend runtime settings: endpoints / tabs / defaults / schemas), `GET/POST /api/v1/settings`
- `GET /healthz` / `GET /readyz` (also returns connectivity for `components: { recorder, monitor, streamer }`)
- `GET /openapi.json` (OpenAPI. The frontend auto-generates the client with Orval)

## Run Lifecycle (centrally managed by the orchestrator)

1. `POST /api/v1/record/start` → the orchestrator **assigns a `run_id`** and creates the run in SQLite (`state=created`).
2. Calls the recorder's `POST /record/start` (passing `run_id`). On success, `state=recording`; on failure, **the run row is kept and updated to `state=failed`** (recording the reason. The DB row is not deleted).
3. Immediately after a successful start, fetch the recorder's `GET /record/metadata` and **sync the finalized topics / type / QoS (including the `"all"` expansion result) into the run row**. If the fetch fails, leave it as `recording`, record the reason in `error`, and retry.
4. `POST /api/v1/record/stop` → recorder stop → re-sync the final metadata (`message_count` / `bytes` / `ended_at` / topics) and set `state=completed`. If it completes while still unable to sync, set `state=completed` and leave the sync failure in `error` (subject to reconciliation).
5. **Reconciliation on restart**: at startup, reconcile runs in `recording` / `stopping` against the recorder's `GET /record/status`, and if no actual instance exists, update to `state=interrupted`.

- `run_id` is owned by the orchestrator and passed to the recorder. **SQLite is the single source of truth**; the recorder's `manifest.json` is for auditing.
- A run row's `topics` / type / QoS come from the recorder's metadata (the orchestrator syncs them at the timings above).
- The run state enum follows the shared [config](config.md).

## SSE Event Contract (`GET /api/v1/events`)

- Format: `id:` (a monotonically increasing integer) / `event:` (kind) / `data:` (JSON).
- Kinds and payloads:
  - `record_status`: `{ run_id, state, message_count, bytes }`
  - `metrics`: a periodic snapshot from `topic_monitor` (the output schema of [topic_monitor](topic_monitor.md))
  - `alert`: `{ topic, metric, level, value, threshold }`
  - `job`: `{ job_id, run_id, pipeline, state, progress }`
- Reconnection: the client sends `Last-Event-ID`. The server keeps recent events in a ring buffer (default 1000 entries / 5 minutes) and resends what was not delivered. If out of range, it sends `event: resync` and the client refetches everything.

## Main Schemas (excerpt, OpenAPI generation target / pydantic)

- settings (`GET/POST /api/v1/settings`): `{ defaults: { encoding: "vp8"|"h264", expected_hz: { <pattern>: number } }, alerts: [ { topic, metric, op, threshold, cooldown_s, clear_after_s } ], retention_days: int, max_record_bytes: int }`. POST is a partial update. Settings override / supplement `RECORDING_CONFIG` at runtime and take effect **from the next recording session / the monitor's re-subscription** (they do not apply retroactively to a recording in progress).
- Validation templates:
  - `GET /api/v1/validation/templates` → `{ items: [ { name, version, required_topics: [ { name, type?: string } ] } ], next_cursor }`
  - `POST /api/v1/validation/templates` body = `{ name, version, required_topics: [ { name, type? } ] }` → `201`, same shape
  - `POST /api/v1/validation/templates/generate` body = `{ run_id }` → `{ name, version, required_topics: [ ... ] }` (a template)
- run (`GET /api/v1/runs/{id}`): `{ run_id, state, started_at, ended_at?: string|null, topics: [ { name, type, qos } ], compression, split?: object|null, error?: { code, message }|null }`.
- job (`GET /api/v1/jobs/{id}/status`): `{ job_id, run_id, pipeline, state, progress, logs_tail }` ([dora_runner](dora_runner.md)).

## Framework / Persistence

- **FastAPI + uvicorn** (recommended. Auto-publishes OpenAPI).
- Heavy processing (validation / conversion, stage3) is placed on an **asynchronous job queue** and decoupled from request/response. Progress is notified via SSE.
- Persistence: **runs / jobs / settings are canonical in SQLite**, the file manifest is for auditing. Avoid accidents where only one side is updated.
- Internal service calls use a timeout (default `3s`) + 1 retry. Failures are reflected in `status` / `events` (`503`).

## Errors / Conventions / Network

- The common API conventions (status codes `400`/`404`/`409`/`422`/`503`/`507`, error format, paging, enums, types / time) follow [config](config.md).
- bind is `BIND_HOST` (default `0.0.0.0`, **LAN exposure allowed**. Assumes a trusted LAN, no authentication). CORS is `CORS_ORIGINS` (add the relevant host's origin when exposing on a LAN).

## Design Points

- **backend-driven**: the orchestrator provides pipeline definitions, form schemas, and tab layout (the frontend does not hardcode them).
- Video (WebRTC) is connected directly by the frontend to `webrtc_streamer`. Everything else is aggregated by the orchestrator.
- Shared settings are in [config](config.md).
