<!-- AUTO-GENERATED from docs/specs/ja/dora_runner.md. Do not edit by hand — edit the Japanese source and run /sync-docs. -->
# dora_runner specification

> Status: design finalized (v1). Based on `fig_const/dora.png`, with unspecified items fixed as recommended designs. Japanese is the source of truth (treat it as canonical). The English version `docs/specs/en/dora_runner.md` is an auto-generated mirror (do not edit it directly). **No authentication required.**

The post-recording **validation / conversion / extension processing pipeline** container (**dora**-based). Taking recorded MCAP as input, it runs validation, conversion, and **AI processing** as asynchronous jobs. All heavy processing is concentrated here, keeping `rosbag2_recorder` / `topic_monitor` lightweight. The design centers on **maximally leveraging dora's extensibility and AI integration**.

## Role

- Perform validation / conversion / extension (including AI) on recorded MCAP.
- Make each process assemblable as swappable, chainable parts.

## Design center: dora extensibility & AI integration

- Each process (validator / converter / **AI node**) is implemented as a **dora node (plugin)** and connected via a **dora dataflow (YAML)**.
- The **Plugin Registry** registers nodes, and the **Pipeline Registry** manages dataflows (= pipelines). **Adding a pipeline = adding a dataflow YAML + a node**, with no core changes needed.
- A node's **I/O is fixed as a contract**:
  - Input: `run` (path / metadata / manifest), an MCAP message iterator (topic filter and time range can be specified), `params`.
  - Output: `metrics` (dict), `artifacts` (a list of generated-output paths), `report` fragments.
  - This lets nodes be freely swapped and chained.
- **Make AI integration a first-class citizen**: inference / auto-annotation / embedding & search indexing / quality scoring / training dataset conversion (e.g. **LeRobot** format) can be plugged in as **AI dora nodes**.
  - The node interface assumes model swapping (`params.model`, etc.). GPU usage is available (`--gpus` / environment variables). Messages can be batch-processed.
  - For reproducibility, the report records pipeline / node / model versions.
- Because it is a dora dataflow, streaming / distributed execution / node reuse all apply.

## Input

- `/data/recorded/<run>/*.mcap` (+ `metadata.yaml` / `manifest.json`)
- pipeline definitions (dataflow YAML)
- config ([config](config.md), validation templates, etc.)
- job record (originating from `api_orchestrator`)

## Constituent components

- **MCAP Loader** — reads with `mcap` + `mcap-ros2-support` (**no rclpy required**, file iteration). Obtains topic / type / timestamp / size, and decodes only when needed.
- **Plugin Registry** — registration and discovery of dora nodes (validator / converter / AI).
- **Pipeline Executor** — execution and ordering control of dora dataflows. Per-job timeout / resource limits.
- **Result Writer** — output of reports / converted products.
- **Job Status / Logs** — state, progress, and logs (SSE to `api_orchestrator`).

## Runnable pipelines (figure)

- `fast_validation` / `full_validation` / `dataset_convert` / `dataset_validation`
- **Implemented (`enabled=true`)**: `fast_validation` / `dataset_export` / `loss_report` / `video_check` (below). `full_validation` / `dataset_convert` / `dataset_validation` are interface and plugin slots only (`enabled=false`).
- All jobs are launched via `POST /jobs` (proxied by `api_orchestrator`). Each pipeline validates `run_id` (`^[A-Za-z0-9_-]+$`) to prevent path traversal.

## Implemented pipelines

- **`dataset_export`** — **moves** `recorded/<run_id>` to `data/<operator>/<task>/<NNN>` (operator / task come from the run's `session.json`. `NNN` is zero-padded auto-numbering of 001, 002…. Path components are sanitized). Since it is a per-file rename on the same mount, it is fast even for large bags. **After the move, the recording disappears from `recorded/`** (the orchestrator exports only completed runs, and reserves `NNN` before moving files, so no data is lost even on interruption). `recorded/<run_id>` and its sibling files (`.qos.yaml` / `.failed.json`) are also deleted, and provenance is saved to `<NNN>/dataset.json`. Report: `data/report/dataset_export/<run_id>/summary.json`. Bulk / individual launch is via the orchestrator's `POST /api/v1/datasets/export(-all)` (the run row is also deleted on success).
- **`loss_report`** — robot-independent, config-free per-topic loss estimation. From the message times of a completed MCAP, it computes the **median interval** per topic and derives `loss ≈ 1 − actual/expected` (read-only, does not decode payloads). The clock **prefers the sender-side `publish_time` (DDS source timestamp)** to keep receive-side jitter (DDS transport, recorder scheduling/cache) out of the cadence estimate. publish_time is trusted only when every message carries a real source stamp (**non-zero** and **different from log_time**) AND the two clocks span the same recording window (within 2x); otherwise (older rosbag2's `pub==log`, a log/source mix, `0`, or offset publisher clocks) it falls back to the single receive-side `log_time` — so publish_time is never worse than before. Note this is an **inferred estimate, not a measurement**: publish_time cannot separate a source that stopped publishing from a message lost in transport before the recorder wrote it (a pre-record loss has no MCAP record, so its publish_time is gone too). **Which clock produced the numbers is stated per topic as `time_source`** (`"publish_time"` / `"log_time"`; honesty rule). Report: `data/report/loss_report/<run_id>/summary.json`.
- **`video_check`** — on-demand (params `{topic}`) `CompressedImage`→mp4 preview. Generated with PyAV (`av` + `Pillow`), which are **lazily imported** so the service can start even when the packages are absent (when absent it becomes a clearly failed job). Output is `data/report/video_check/<run_id>/<topic>.mp4`, served via `GET /api/v1/files/...`. The encode cap is params `max_frames` (default 900, **`0` = every frame**). A summary cut off at the cap carries `truncated: true` and the real total message count, and the UI shows a "head only" label plus a **Re-encode full episode** button (re-posting `{force: true, max_frames: 0}`). The playback fps is estimated from the frame-time cadence under the same rule as loss_report — **`publish_time` preferred, `log_time` fallback** (the clock used is stated as `fps_time_source` in the summary). The mp4 is encoded to a temp file and atomically renamed, so a re-encode that fails midway never corrupts an mp4 being served. The (run_id, topic) cache is cap-aware (a truncated cache misses a full-length request; an untruncated one within the requested cap hits).
- **Post-export reads (`params.dataset_dir`)** — `loss_report` / `video_check` accept an optional `dataset_dir` (`<operator>/<task>/<NNN>`, relative to `data/`) and **read the MCAP from the exported dataset directory** instead of `recorded/<run_id>` (`dataset_export` is a move, so after export there is no bag in `recorded/`). Outputs / caches stay **keyed by run_id** (`data/report/<pipeline>/<run_id>/`) as before, so a video_check mp4 cache generated before export is reused as-is after it (the move preserves mtimes). `dataset_dir` only allows exactly 3 plain-name components (traversal and the reserved names `recorded`/`report`/`datasets` are a `ValueError` → failed job).

## Validation (v1): required topics + template

- **Validation template** (YAML / JSON): defines the topics required for that dataset / robot.
  ```yaml
  name: hsr_teleop_v1
  version: 1
  required_topics:
    - { name: "/joint_states", type: "sensor_msgs/msg/JointState" }  # type is optional
    - { name: "/camera/*/image_raw" }                                 # glob allowed
  # optional: expected_hz, min_duration_s, etc. can be added later
  ```
- **Automatic template generation**: generate a draft template from the topic list of an existing good run (`metadata.yaml` / MCAP) → a human selects and finalizes it.
- **`fast_validation`**: matches the target run's topic list against the template and judges the **presence/absence of required topics**. No decode required, short duration.
  - Output `summary.json`: `{ template, result: "pass"|"fail", missing: [], extra: [], checked_at }`.

## Output

- `/data/report/<pipeline>/<run>/` (`summary.json` / preview / logs)
- `/data/converted/<run>/` (output of `dataset_convert`. e.g. training format)
- job record (the user-facing canonical store is **`api_orchestrator`'s SQLite**; dora_runner also persists its own internal state — see "Persistence and restart reconciliation" below)

## Persistence and restart reconciliation

- **Jobs and validation templates are persisted in SQLite** (`store.py`; default `<data_dir>/dora_runner.db`, beside the `report/` tree in the same data directory). It follows the same conventions as `api_orchestrator.store`: a `threading.RLock` serializes connection use, and `PRAGMA user_version` records the schema version. Previously this state was in-memory and was lost on process restart (release-readiness finding F4/MS-6).
- **Execution stays in-process** (this persists *state*, not a distributed queue). A running job is held as a live `JobRecord` (owning its `asyncio.Task`) and is **checkpointed** to its row on each state transition (queued → running → terminal); it is not written per log line. `logs_tail` is stored with the terminal row.
- **Restart reconciliation**: on startup (`create_dora_app`), any job left `queued`/`running` is resolved to a terminal `failed` state carrying the reason in its `summary` (`{result:"fail", reason:"interrupted", error:{code:"job_interrupted", message:"dora_runner restarted while the job was in flight."}}`), and an interrupted note is appended to `logs_tail`. `JobState` has no `interrupted` member, and `api_orchestrator`'s `run_job_to_completion` treats only succeeded/failed/canceled as terminal — so **interrupted collapses onto `failed` with the reason in the summary** (the same representation as timeout). `datasets._job_failure_reason` and the Validation tab's generic renderer then surface it to the user with no orchestrator/frontend changes.
- `GET /jobs/{id}/status` / `GET /jobs/{id}/result` prefer the live `JobRecord` and fall back to the SQLite row, so a job whose worker vanished with the old process still returns a terminal state and result.

## API (service-internal API; public exposure is via `api_orchestrator`)

- `POST /jobs` — `{ run_id, pipeline, params? }` → `{ job_id }`
- `GET /jobs/{id}/status` — `{ state: "queued"|"running"|"succeeded"|"failed"|"canceled", progress, logs_tail }`
- `GET /jobs/{id}/result` — `{ summary, artifacts: [] }`
- `POST /jobs/{id}/cancel`
- `GET /pipelines` — list of available pipelines (dataflows)
- Validation templates: `GET/POST /validation/templates`, `POST /validation/templates/generate` (generate a draft from a run)
- `GET /healthz` / `GET /readyz`

## Data flow

MCAP → dora dataflow (validator / converter / AI nodes) → reports / converted dataset

## Design points

- validator / converter / AI are dora nodes (plugins). I/O is a contract.
- Heavy processing is asynchronous jobs. Progress is delivered via SSE `api_orchestrator` → frontend.
- Extend as a dora dataflow (add / swap / chain nodes). Treat **AI nodes as first-class citizens**.
- backend-driven: pipeline definitions and form schemas are distributed to the frontend by `api_orchestrator` (the Validation tab's execution form, etc.).
- Shared configuration is in [config](config.md).

## Implementation status and development guide

This document is the **source of truth for the design (including the future vision)**. **The currently enabled pipelines are these four: `fast_validation` / `dataset_export` /
`loss_report` / `video_check`** (see "Implemented pipelines" above). `full_validation` /
`dataset_convert` / `dataset_validation` are interface only (`enabled=false`; `POST /jobs`
rejects them with `pipeline_unavailable`).

**Implemented**: the **Plugin/Pipeline Registry** (`registry.py`'s `build_default_registry()` registers the
4 bundled pipelines, and `plugin_loader.discover_plugins()` scans manifests under `KAIROS_PLUGINS_DIR`
(default `services/dora_runner/plugins/`) for automatic registration; an example `hello_dora` plugin is
bundled), the **in-process dora dataflow interpreter** (plugins that declare `executor: dora` also run
in-process, for the reasons below), and **job concurrency limits and per-job timeouts**
(`KAIROS_DORA_MAX_CONCURRENCY` / `KAIROS_DORA_JOB_TIMEOUT_S`), and **SQLite persistence of jobs/templates with
restart reconciliation** (see "Persistence and restart reconciliation" above). Each pipeline's heavy reads and
encoding are offloaded to worker threads.

**Not implemented / not bundled**: the Rust **dora CLI/daemon (coordinator) is not bundled**. Accordingly,
`/readyz` honestly reports the **actual execution backend** in `components.dora` (`available` if the `dora`
binary is present, otherwise `in-process`), while `status` stays `ready` even without dora (since it runs
in-process). Each `PipelineDefinition` returned by `/pipelines` also reports `effective_executor` (how it
actually runs), distinct from the declared `executor`. **AI nodes** (inference / LeRobot conversion) are not
implemented.

For how to add validation checks, unit testing, and debugging procedures via the local CLI (`python -m dora_runner.cli`),
see the developer guide [docs/dora/README.md](../../dora/README.md).

The **implementation plan for the dora dataflow conversion & plugin system** (future vision) is finalized
in [dora_plugins.md](dora_plugins.md) (dataflow conversion for all pipelines, automatic registration via
manifest scan of `plugins/<name>`, and the phased migration plan). The current plugins are **in-tree**
(placed directly under `services/dora_runner/plugins/` rather than as a submodule); the dora daemon is only
a reserved slot for a future investment.
