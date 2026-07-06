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
- **`loss_report`** — robot-independent, config-free per-topic loss estimation. From the message log_time of a completed MCAP, it computes the **median inter-arrival interval** per topic and derives `loss ≈ 1 − actual/expected` (read-only, does not decode payloads). Report: `data/report/loss_report/<run_id>/summary.json`.
- **`video_check`** — on-demand (params `{topic}`) `CompressedImage`→mp4 preview. Generated with PyAV (`av` + `Pillow`), which are **lazily imported** so the service can start even when the packages are absent (when absent it becomes a clearly failed job). Output is `data/report/video_check/<run_id>/<topic>.mp4`, served via `GET /api/v1/files/...`. Frame cap 900.
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
- job record (**the SQLite of `api_orchestrator` is canonical**)

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
(`KAIROS_DORA_MAX_CONCURRENCY` / `KAIROS_DORA_JOB_TIMEOUT_S`). Each pipeline's heavy reads and encoding
are offloaded to worker threads.

**Not implemented / not bundled**: the Rust **dora CLI/daemon (coordinator) is not bundled**. Accordingly,
`/readyz` honestly reports the **actual execution backend** in `components.dora` (`available` if the `dora`
binary is present, otherwise `in-process`), while `status` stays `ready` even without dora (since it runs
in-process). Each `PipelineDefinition` returned by `/pipelines` also reports `effective_executor` (how it
actually runs), distinct from the declared `executor`. **AI nodes** (inference / LeRobot conversion) and
**job/template persistence** (currently in-memory, lost on process restart) are also not implemented.

For how to add validation checks, unit testing, and debugging procedures via the local CLI (`python -m dora_runner.cli`),
see the developer guide [docs/dora/README.md](../../dora/README.md).

The **implementation plan for the dora dataflow conversion & plugin system** (future vision) is finalized
in [dora_plugins.md](dora_plugins.md) (dataflow conversion for all pipelines, automatic registration via
manifest scan of `plugins/<name>`, and the phased migration plan). The current plugins are **in-tree**
(placed directly under `services/dora_runner/plugins/` rather than as a submodule); the dora daemon is only
a reserved slot for a future investment.
