<!-- AUTO-GENERATED from docs/specs/ja/rosbag2_recorder.md. Do not edit by hand — edit the Japanese source and run /sync-docs. -->

# rosbag2_recorder specification

> Status: design finalized (v1). Based on `fig_const/rosbag2recorder.png`, with unspecified items finalized as recommended design. Japanese is the source of truth (treat it as canonical). The English version `docs/specs/en/rosbag2_recorder.md` is an auto-generated mirror (do not edit directly). **No authentication is required.**

A container that **formally records ROS 2 topics to MCAP**. The official raw-data recording path (**canonical**). This is the only container that records raw data.

## Role

- Specializes in recording the selected ROS 2 topics to MCAP without loss.
- 1 container = 1 recording session (only one recording at a time).

## Input

- Selected ROS 2 topics (an explicit list, or `"all"`)
- record config (compression / split / QoS, etc.)
- run_id / output_dir
- `default_topics` / `topic_qos_overrides` from `RECORDING_CONFIG` ([config](config.md))

## Components

- **Topic Selector** — filters what to record. `"all"` expands the topic list as of start time and freezes it in the manifest.
- **Recorder** — records via `ros2 bag record --storage mcap` (subprocess, robust and standard-compliant) or the rosbag2 Python API (kairos uses the former).
- **MCAP Writer** — `storage_id=mcap` (canonical), `serialization=cdr`.
- **metadata.yaml Writer** — rosbag2 standard metadata output.
- **Compression / Split management** — compression (`none` / `zstd`) and splitting (by size / time).

## QoS / image support

- **By default rosbag2 follows each publisher's offered QoS** (recommended; this avoids dropping best_effort publishers). Overrides are optional.
- **QoS is selectable per recorded topic**: `reliability` (`reliable` / `best_effort`), `durability` (`volatile` / `transient_local`), `depth`. For `ros2 bag record` they are passed via `--qos-profile-overrides-path` (YAML).
  - Note: with `topics: "all"`, config pattern QoS overrides cannot be pre-applied (the actual topic set is unknown before start). Only explicit per-request overrides are applied.
- **Image support**: `sensor_msgs/Image` / `sensor_msgs/CompressedImage` / ffmpeg (`ffmpeg_image_transport`). All are recorded to MCAP as raw bytes (no re-encoding).

## Custom message support

- Topics with non-standard types (e.g. `tmc_control_msgs/msg/ServoState`) are also recorded. **The message definition (type support) is assumed to exist in the recording environment** (the `msgs are present` assumption).
- Mechanism: mount a colcon overlay (`install/`) that built the custom msg packages into the recording container and source it at startup (the path is given via an environment variable). If rosbag2 can resolve type support it records the raw cdr (it does not decode).
- A topic whose type support cannot be resolved is skipped by rosbag2 (not expected to occur under the assumption above).

## API (internal service API; exposed via `api_orchestrator`)

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
- `POST /record/stop` — **idempotent**. Recording → stop and `200`; idle → `200` (returns the current state).
- `GET /record/status` — `{ state, run_id?, started_at?, message_count, bytes, topics: [], dropped_messages?, integrity }` (`dropped_messages` / `integrity`: see [drop detection](#drop-detection-recording-cache-integrity))
- `GET /record/metadata` — metadata of the latest run (rosbag2 standard + kairos manifest)
- `GET /healthz` / `GET /readyz`
- Errors: an unwritable `/data` or insufficient free space rejects recording (`507`-equivalent). A duplicate start returns `409`.

## Start-time drop mitigation (start-paused readiness gate, optional)

After spawn, `ros2 bag record` does not establish a subscription to the target topics until DDS discovery → subscription match completes, and VOLATILE/best_effort messages during that window are not recorded (`start_delay_s` is for publisher warm-up and is a different concern from this lag).

Enable the mitigation with `recording.start_paused: true` (default `false`): start the recorder with **`--start-paused`** → wait until the subscriptions to the target topics are established on the graph (up to `subscription_ready_timeout_s`) → call the recorder's `~/resume` and only then return "recording". This keeps **all subscriptions live from resume onward**. **Fail-safe**: if resume cannot be confirmed, fail the start visibly (`507 record_arm_failed`) — never leave it paused and silently recording nothing. The readiness check and resume use rclpy + a rosbag2 service and run only in the ROS image (outside CI), so they are intended to be **enabled per deployment after verification**. For single-shot/latched topics that require t0, making the publisher side transient_local is a complementary measure.

Resume is done via the **rosbag2 `~/resume` service**, so it does not depend on the interactive SPACE key (which requires a pseudo-TTY/pty). The recorder is always passed `--disable-keyboard-controls` to disable keyboard control (removing needless overhead and the TTY dependency).

## Drop detection (recording cache integrity)

`ros2 bag record` accumulates received messages in an **in-memory cache** (`--max-cache-size`, default 100 MiB) that a writer thread flushes to disk. Under bursts, slow storage, or CPU constraints, **if writing cannot keep up the cache overflows and the excess is silently discarded** (rosbag2 prints `Total lost: N` to stderr at shutdown). This is the main data-loss path during recording.

- **Cache tuning**: `recording.max_cache_size_mb` (MiB) overrides `--max-cache-size`. `0` omits the flag and uses the rosbag2 default (100 MiB). Larger values increase burst tolerance. The bundled real-robot profile sets **512**. Because of double buffering the worst-case RAM is about `2×`, and free RAM is preflighted before start (`507 insufficient_memory` if short).
- **Drop detection**: the recorder's stdout/stderr is captured to a **file** (`<run_id>.recorder.log`, a sibling of the run directory) and scanned for `Total lost: N` at finalise. **Because it is a file, not a pipe**, it does not cause a fixed-size-buffer flush stall at stop time (pipe-stall) and the log can be scanned afterward (impossible with inherit-to-container-log). The result is exposed as `dropped_messages` (the count dropped; `null` means unknown) and `integrity` (`ok` / `dropped` / `failed` / `unknown`) in `manifest.json` and `GET /record/status`. Even a cleanly completed run that overflowed is reported as `completed` with `integrity=dropped` (= data was lost).
- The log is moved into the run directory after finalise (`recorded/<run_id>/recorder.log`) so it can be audited alongside the bag.

## Output / artifacts

- `/data/recorded/<run_id>/<run_id>_*.mcap` (sequential when split)
- `metadata.yaml` (rosbag2 standard)
- `manifest.json` (kairos-specific): run_id / state / selected topics (type, QoS) / started_at, ended_at (UTC) / compression / split / error? / `dropped_messages` / `integrity`.
  - **The source of truth for runs is the SQLite in `api_orchestrator`**; the manifest is for auditing.
- `recorder.log` (moved into the run directory after finalise): the recorder process's stdout/stderr. The source for analyzing `Total lost` (cache overflow), etc.
- `session.json` (in the same directory as the MCAP): operator / task (defaulting to `unknown_operator` / `unknown_task` when omitted) plus counts, etc. Used by `dora_runner`'s dataset export to decide the destination `data/<operator>/<task>`.
- run states: `created` | `recording` | `stopping` | `completed` | `failed` | `interrupted`.

## Configuration (config)

- The character set of `run_id` is `[A-Za-z0-9_-]+` (path-traversal prevention).
- With `MAX_RECORD_BYTES > 0`, auto-stop on exceeding it.
- `default_topics` / `topic_qos_overrides` come from the `RECORDING_CONFIG` YAML (pattern match). `ROS_DOMAIN_ID` / `DATA_DIR` / `BIND_HOST` are in the shared [config](config.md).

## Design points

- **MCAP is canonical.** Specialized in recording raw data without loss, compliant with ROS 2 standards.
- A run interrupted by a restart, etc., leaves `state=interrupted` in the manifest.
- `run_id` is assigned and passed by `api_orchestrator`. The recorder's responsibility is limited to recording and providing status / manifest; **the source of truth for runs is the orchestrator's SQLite** (Run lifecycle and reconciliation: [api_orchestrator](api_orchestrator.md)).
- Heavy validation and conversion are delegated to `dora_runner` (this container does not do them).
