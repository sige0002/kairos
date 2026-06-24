<!-- AUTO-GENERATED from docs/specs/ja/dora_runner.md. Do not edit by hand — edit the Japanese source and run /sync-docs. -->

# dora_runner Specification

> Status: design finalized (v1). Based on `fig_const/dora.png`, with unspecified items finalized as the recommended design. Japanese is the source of truth (it takes precedence). The English version `docs/specs/en/dora_runner.md` is an auto-generated mirror (do not edit it directly). **No authentication required.**

A container for the **post-recording validation / conversion / augmentation processing pipeline** (**dora**-based). It takes recorded MCAP as input and runs validation, conversion, and **AI processing** as asynchronous jobs. All heavy processing is concentrated here, keeping `rosbag2_recorder` / `topic_monitor` lightweight. The design centers on **maximizing dora's extensibility and AI integration**.

## Role

- Performs validation / conversion / augmentation (including AI) on recorded MCAP.
- Allows each process to be assembled as a swappable, chainable part.

## Design center: dora extensibility & AI integration

- Each process (validator / converter / **AI node**) is implemented as a **dora node (plugin)** and connected via a **dora dataflow (YAML)**.
- The **Plugin Registry** registers nodes, and the **Pipeline Registry** manages dataflows (= pipelines). **Adding a pipeline = adding a dataflow YAML + a node**; no core changes are needed.
- A node's **I/O is fixed as a contract**:
  - Input: `run` (path / metadata / manifest), an MCAP message iterator (topic filtering / time-range specification possible), `params`.
  - Output: `metrics` (dict), `artifacts` (a list of generated-artifact paths), `report` fragment.
  - This lets nodes be freely swapped and chained.
- **Make AI integration a first-class citizen**: inference / auto-annotation / embedding & search index / quality scoring / training dataset conversion (e.g. **LeRobot** format) can be plugged in as **AI dora nodes**.
  - The node interface assumes model swapping (`params.model`, etc.). GPU usage is available (`--gpus` / environment variables). Messages can be batch-processed.
  - For reproducibility, the report records the versions of the pipeline / node / model.
- Because it is a dora dataflow, streaming / distributed execution / node reuse all work.

## Input

- `/data/recorded/<run>/*.mcap` (+ `metadata.yaml` / `manifest.json`)
- pipeline definition (dataflow YAML)
- config ([config](config.md), validation templates, etc.)
- job record (originating from `api_orchestrator`)

## Components

- **MCAP Loader** — reads with `mcap` + `mcap-ros2-support` (**no rclpy needed**, file iteration). Obtains topic / type / time / size, and decodes only when necessary.
- **Plugin Registry** — registration and discovery of dora nodes (validator / converter / AI).
- **Pipeline Executor** — execution and ordering control of the dora dataflow. Per-job timeout / resource caps.
- **Result Writer** — outputs reports / converted artifacts.
- **Job Status / Logs** — state / progress / logs (SSE to `api_orchestrator`).

## Executable pipelines (diagram)

- `fast_validation` / `full_validation` / `dataset_convert` / `dataset_validation`
- **v1 implementation scope**: first **`fast_validation` = a presence check for required topics** + **creation of validation templates**. For the rest, provide only the interface and plugin slots, implementing them incrementally.

## Validation (v1): required topics + templates

- **Validation template** (YAML / JSON): defines the topics required for that dataset / robot.
  ```yaml
  name: hsr_teleop_v1
  version: 1
  required_topics:
    - { name: "/joint_states", type: "sensor_msgs/msg/JointState" }  # type is optional
    - { name: "/camera/*/image_raw" }                                 # glob allowed
  # optional: expected_hz, min_duration_s, etc. (added later)
  ```
- **Automatic template generation**: generate a draft template from the topic list of an existing good run (`metadata.yaml` / MCAP) → a human selects and finalizes it.
- **`fast_validation`**: matches the target run's topic list against the template and determines **the surplus/shortfall of required topics**. No decoding needed; short duration.
  - Output `summary.json`: `{ template, result: "pass"|"fail", missing: [], extra: [], checked_at }`.

## Output

- `/data/report/<pipeline>/<run>/` (`summary.json` / preview / logs)
- `/data/converted/<run>/` (output of `dataset_convert`. e.g. training format)
- job record (**the `api_orchestrator` SQLite is the source of truth**)

## API (service-internal API. Publicly exposed via `api_orchestrator`)

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
- Heavy processing is asynchronous jobs. Progress goes via SSE to `api_orchestrator` → frontend.
- Extend as a dora dataflow (adding / swapping / chaining nodes). **Treat AI nodes as first-class citizens.**
- backend-driven: pipeline definitions and form schemas are distributed by `api_orchestrator` to the frontend (Pipelines tab).
- Shared configuration is in [config](config.md).
