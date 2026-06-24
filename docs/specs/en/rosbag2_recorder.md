<!-- AUTO-GENERATED from docs/specs/ja/rosbag2_recorder.md. Do not edit by hand — edit the Japanese source and run /sync-docs. -->

# rosbag2_recorder specification

> Status: design finalized (v1). Based on `fig_const/rosbag2recorder.png`, with unstated items finalized as the recommended design. Japanese is the source of truth (treat it as authoritative). The English version `docs/specs/en/rosbag2_recorder.md` is an auto-generated mirror (do not edit it directly). **No authentication required.**

A container that **formally records ROS 2 topics into MCAP**. The official raw-data recording path (**the canonical source**). This container is the only one that records raw data.

## Role

- Specializes in the role of recording selected ROS 2 topics into MCAP without loss.
- 1 container = 1 recording session (only one concurrent recording).

## Inputs

- Selected ROS 2 topics (an explicit list, or `"all"`)
- record config (compression / split / QoS, etc.)
- run_id / output_dir
- `default_topics` / `topic_qos_overrides` from `RECORDING_CONFIG` ([config](config.md))

## Component breakdown

- **Topic Selector** — filtering of the recording targets. `"all"` expands to the topic list at start time and freezes it into the manifest.
- **Recorder** — actual recording via `ros2 bag record --storage mcap` (subprocess, robust and standards-compliant) or the rosbag2 Python API (`../rosbag-view` uses the former).
- **MCAP Writer** — `storage_id=mcap` (canonical), `serialization=cdr`.
- **metadata.yaml Writer** — rosbag2 standard metadata output.
- **Compression / Split management** — compression (`none` / `zstd`) and splitting (by size / time).

## QoS / image support

- **By default, rosbag2 follows each publisher's offered QoS** (recommended; this avoids dropping messages even from best_effort publishers). Override is optional.
- **QoS can be selected per recorded topic**: `reliability` (`reliable` / `best_effort`), `durability` (`volatile` / `transient_local`), `depth`. With `ros2 bag record`, pass it via `--qos-profile-overrides-path` (YAML).
  - Note: with `topics: "all"`, the config's pattern QoS overrides cannot be pre-applied (because the actual topic set is unknown before start). Only explicit per-request overrides are applied.
- **Image support**: `sensor_msgs/Image` / `sensor_msgs/CompressedImage` / ffmpeg (`ffmpeg_image_transport`). All are recorded into MCAP as raw bytes (no re-encoding).

## Custom message support

- Also records topics with non-standard types (e.g., `tmc_control_msgs/msg/ServoState`). **Assumes the message definitions (type support) exist in the recording environment** (`msgs are assumed to be present`).
- Mechanism: mount a colcon overlay (`install/`) built from the custom msg packages into the recording container and source it at startup (the path is specified via an environment variable). As long as rosbag2 can resolve the type support, it records raw cdr (it does not decode).
- Topics whose type support cannot be resolved are skipped by rosbag2 (not expected to occur under the assumption above).

## API (service-internal API; published via `api_orchestrator`)

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
- `POST /record/stop` — **idempotent**. recording→stop and `200`, idle→`200` (returns the current state).
- `GET /record/status` — `{ state, run_id?, started_at?, message_count, bytes, topics: [] }`
- `GET /record/metadata` — metadata of the latest run (rosbag2 standard + kairos manifest)
- `GET /healthz` / `GET /readyz`
- Failures: when `/data` is not writable or free space is insufficient, recording is rejected (equivalent to `507`). Duplicate start is `409`.

## Outputs / artifacts

- `/data/recorded/<run_id>/<run_id>_*.mcap` (sequentially numbered when split)
- `metadata.yaml` (rosbag2 standard)
- `manifest.json` (kairos-specific): run_id / state / selected topics (types, QoS) / started_at, ended_at (UTC) / compression / split / error?.
  - **The source of truth for runs is `api_orchestrator`'s SQLite**; the manifest is for auditing.
- run state: `created` | `recording` | `stopping` | `completed` | `failed` | `interrupted`.

## Configuration (config)

- The character set for `run_id` is `[A-Za-z0-9_-]+` (path traversal prevention).
- With `MAX_RECORD_BYTES > 0`, auto-stop when exceeded.
- `default_topics` / `topic_qos_overrides` come from the `RECORDING_CONFIG` YAML (pattern match). `ROS_DOMAIN_ID` / `DATA_DIR` / `BIND_HOST` are from the shared [config](config.md).

## Design points

- **MCAP is canonical.** Specializes in recording raw data without loss, and complies with ROS 2 standards.
- A run interrupted by a restart or similar leaves `state=interrupted` in the manifest.
- `run_id` is assigned and passed by `api_orchestrator`. The recorder limits its responsibility to recording and providing status / manifest, and **the source of truth for runs is the orchestrator's SQLite** (Run lifecycle and reconciliation are in [api_orchestrator](api_orchestrator.md)).
- Heavy validation/conversion is delegated to `dora_runner` (this container does not do it).
