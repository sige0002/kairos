<!-- AUTO-GENERATED from docs/specs/ja/rosbag2_recorder.md. Do not edit by hand — edit the Japanese source and run /sync-docs. -->
# rosbag2_recorder Specification

> Status: design finalized (v1). Based on `fig_const/rosbag2recorder.png`, with unspecified items fixed as recommended designs. Japanese is the source of truth (it is authoritative). The English version `docs/specs/en/rosbag2_recorder.md` is an auto-generated mirror (do not edit it directly). **No authentication.**

The container that **officially records ROS 2 topics to MCAP**. The official raw-data recording path (**the source of truth**). This is the only container that records raw data.

## Role

- Specializes in the role of recording selected ROS 2 topics to MCAP without loss.
- 1 container = 1 recording session (only a single recording at a time).

## Input

- Selected ROS 2 topics (an explicit list, or `"all"`)
- record config (compression / split / QoS, etc.)
- run_id / output_dir
- `default_topics` / `topic_qos_overrides` from `RECORDING_CONFIG` ([config](config.md))

## Component structure

- **Topic Selector** — filtering of recording targets. `"all"` expands to the list of topics at start time and fixes it in the manifest.
- **Recorder** — actual recording via `ros2 bag record --storage mcap` (subprocess, robust and standards-compliant) or the rosbag2 Python API (kairos uses the former).
- **MCAP Writer** — `storage_id=mcap` (the source of truth), `serialization=cdr`.
- **metadata.yaml Writer** — rosbag2 standard metadata output.
- **Compression / Split management** — compression (`none` / `zstd`) and splitting (by size / time).

## QoS / image support

- **By default rosbag2 follows each publisher's offered QoS** (recommended; this means best_effort publishers are not dropped either). Overrides are optional.
- **QoS can be selected per acquired topic**: `reliability` (`reliable` / `best_effort`), `durability` (`volatile` / `transient_local`), `depth`. With `ros2 bag record` they are passed via `--qos-profile-overrides-path` (YAML).
  - Note: with `topics: "all"`, config pattern QoS overrides cannot be applied in advance (because the actual topic set is unknown before start). Only explicit per-request overrides are applied.
- **Image support**: `sensor_msgs/Image` / `sensor_msgs/CompressedImage` / ffmpeg (`ffmpeg_image_transport`). All are recorded into MCAP as raw bytes (no re-encoding).

## Custom message support

- Records topics with non-standard types (e.g. `tmc_control_msgs/msg/ServoState`) as well. **Assumes the message definitions (type support) exist in the recording environment** (`msgs are assumed present`).
- Mechanism: mount the colcon overlay (`install/`) built from the custom msg packages into the recording container and source it at startup (the path is specified via an environment variable). As long as rosbag2 can resolve the type support, it records the raw cdr (it does not decode).
- Topics whose type support cannot be resolved are skipped by rosbag2 (not expected to occur under the above assumption).

## API (internal service API. Exposed externally via `api_orchestrator`)

- `POST /record/start` — body:
  ```json
  {
    "topics": ["..."] ,
    "run_id": "assigned and passed by the orchestrator",
    "compression": "none",
    "split": { "max_size_mb": null, "max_duration_s": null },
    "qos_default": { "reliability": "best_effort", "durability": "volatile", "depth": 10 },
    "qos_overrides": { "/topic": { "reliability": "reliable", "durability": "transient_local", "depth": 1 } }
  }
  ```
  → `201 { run_id, state, started_at }`. The type of `topics` is `string[] | "all"`.
- `POST /record/stop` — **idempotent**. recording → stops and returns `200`, idle → `200` (returns the current state).
- `GET /record/status` — `{ state, run_id?, started_at?, message_count, bytes, topics: [] }`
- `GET /record/metadata` — metadata of the most recent run (rosbag2 standard + kairos manifest)
- `GET /healthz` / `GET /readyz`
- Errors: if `/data` is not writable or there is insufficient free space, recording is rejected (equivalent to `507`). Concurrent start is `409`.

## Loss prevention at start (start-paused readiness gate, optional)

After `ros2 bag record` is spawned, subscriptions to the target topics are not established until DDS discovery → subscription match completes, and VOLATILE/best_effort messages during that interval cannot be recorded (`start_delay_s` is for publisher warmup and is a different matter from this lag).

Enable mitigation with `recording.start_paused: true` (default `false`): start the recorder with **`--start-paused`** → wait until subscriptions to the target topics are established on the graph (up to `subscription_ready_timeout_s`) → call the recorder's `~/resume` before returning "recording". With this, **all subscriptions are live from resume onward**. **Fail-safe**: if resume cannot be confirmed, make start fail visibly (`507 record_arm_failed`). Do not leave it paused and silently record nothing. Because the readiness check and resume use rclpy + rosbag2 services and only run in the ROS image (outside CI), they are intended to be **enabled per deployment after verification**. A complementary measure for single-shot/latched topics that require t0 is to make the publisher side transient_local.

## Output / stored artifacts

- `/data/recorded/<run_id>/<run_id>_*.mcap` (sequential numbers when split)
- `metadata.yaml` (rosbag2 standard)
- `manifest.json` (kairos-specific): run_id / state / selected topics (type / QoS) / started_at・ended_at (UTC) / compression / split / error?.
  - **The source of truth for runs is the `api_orchestrator` SQLite**; the manifest is for auditing.
- `session.json` (same directory as the MCAP): operator / task (defaults to `unknown_operator` / `unknown_task` when omitted) plus counts, etc. Used by `dora_runner`'s dataset export to decide the destination `data/<operator>/<task>`.
- run states: `created` | `recording` | `stopping` | `completed` | `failed` | `interrupted`.

## Configuration (config)

- The allowed character set for `run_id` is `[A-Za-z0-9_-]+` (prevents path traversal).
- With `MAX_RECORD_BYTES > 0`, auto-stop on exceeding it.
- `default_topics` / `topic_qos_overrides` come from the `RECORDING_CONFIG` YAML (pattern match). `ROS_DOMAIN_ID` / `DATA_DIR` / `BIND_HOST` are shared [config](config.md).

## Design points

- **MCAP is the source of truth.** Specializes in recording raw data without loss, conforming to ROS 2 standards.
- A run interrupted by a restart or the like leaves `state=interrupted` in the manifest.
- `run_id` is assigned and passed by `api_orchestrator`. The recorder limits its responsibilities to recording and providing status / manifest, and **the source of truth for runs is the orchestrator's SQLite** (Run lifecycle and reconciliation are in [api_orchestrator](api_orchestrator.md)).
- Heavy validation and conversion are delegated to `dora_runner` (this container does not do them).
