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

- `POST /record/prepare` (two-phase start. [details](#recording-start-latency-many-topics-and-two-phase-start)) — same body shape as `POST /record/start`.
  → `201 { run_id, state: "armed", arming, disarm_at }`.
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
  → `201 { run_id, state, started_at, arming? }`. The type of `topics` is `string[] | "all"`. If a matching `armed` session exists from a preceding prepare, this becomes the fast path that just resumes it ([details](#recording-start-latency-many-topics-and-two-phase-start)).
- `POST /record/stop` — **idempotent**. Recording → stop and `200`; armed → disarm and `200` (idle-equivalent); idle → `200` (returns the current state).
- `GET /record/status` — `{ state, run_id?, started_at?, message_count, bytes, topics: [], dropped_messages?, integrity }` (`dropped_messages` / `integrity`: see [drop detection](#drop-detection-recording-cache-integrity)). While `state: "armed"`, `run_id`/`topics` refer to the armed session, `message_count`/`bytes` are `0`, and `started_at` is `null`.
- `GET /record/metadata` — metadata of the latest run (rosbag2 standard + kairos manifest)
- `GET /healthz` / `GET /readyz`
- Errors: an unwritable `/data` or insufficient free space rejects recording (`507`-equivalent). A duplicate start or duplicate prepare returns `409`.

## Start-time drop mitigation (start-paused readiness gate, optional)

After spawn, `ros2 bag record` does not establish a subscription to the target topics until DDS discovery → subscription match completes, and VOLATILE/best_effort messages during that window are not recorded (`start_delay_s` is for publisher warm-up and is a different concern from this lag).

Enable the mitigation with `recording.start_paused: true` (default `false`): start the recorder with **`--start-paused`** → wait until the subscriptions to the target topics are established on the graph (up to `subscription_ready_timeout_s`) → call the recorder's `~/resume` and only then return "recording". This keeps **all subscriptions live from resume onward**. **Fail-safe**: if resume cannot be confirmed, fail the start visibly (`507 record_arm_failed`) — never leave it paused and silently recording nothing. The readiness check and resume use rclpy + a rosbag2 service and run only in the ROS image (outside CI), so they are intended to be **enabled per deployment after verification**. For single-shot/latched topics that require t0, making the publisher side transient_local is a complementary measure.

Resume is done via the **rosbag2 `~/resume` service**, so it does not depend on the interactive SPACE key (which requires a pseudo-TTY/pty). The recorder is always passed `--disable-keyboard-controls` to disable keyboard control (removing needless overhead and the TTY dependency).

### Recording-start latency (many topics) and two-phase start

**Symptom**: with many topics (e.g. 4 cameras + 27 numeric = 31 topics), it takes several seconds from `POST /record/start` until writing actually begins. The breakdown: ① the **subprocess spawn** of `ros2 bag record` (Python CLI + rclcpp init, 1–3 s), ② the new DDS participant's **discovery + subscription matching for the target topics** (proportional to topic count and graph size; longer on a busy graph), ③ writer init. The UI's "recording (red)" lights on start acceptance, so with `start_paused` disabled this appears as time where it is "**red but not yet recording**" (with it enabled, the same time appears as the start-response wait — a different presentation of the same root cause).

**Decided and implemented (v1): two-phase start (prepare → resume).** Building on the existing start-paused readiness gate, the spawn and matching are finished **before the actual start action**.

1. `POST /record/prepare` — spawns the recorder with **`--start-paused`** **unconditionally**, regardless of the `recording.start_paused` config value, and waits until subscription matching is complete (the same readiness-gate logic, and the same application points for `start_delay_s`/`post_discovery_delay_s`). The matched `~/resume` / `~/is_paused` service clients and the rclpy node are **kept, not discarded** (to make the later resume fast — recreating them here would pay the DDS-participant-creation and service-discovery cost again, defeating the point of two-phase start). Once done, it waits in the **`armed`** state. The run_id is fixed here (rosbag2 opens `--output` at spawn time, so it stays fixed afterward). Response: `201 { run_id, state: "armed", arming, disarm_at }` (`arming.matched_topics` / `missing_topics` reuse the existing arming observational snapshot; `disarm_at` is the auto-disarm deadline below, a different concept from the existing `resume_at` — the single-call gate's own readiness-timeout deadline). Returns `409 already_recording` while recording/stopping (`armed` is excluded from `_ACTIVE_STATES`, which is what keeps it from blocking a normal `start`, but `prepare` itself cannot be called while recording).
2. `POST /record/start` — if an armed session exists AND the **spawn-affecting fields** (the normalised topic selection, `compression`, `split`, `qos_default`, `qos_overrides`) **match** the prepare-time request, this is the fast path: just call `~/resume` via the held clients (**no re-spawn, no discovery wait** — `start_delay_s`/`post_discovery_delay_s` are not re-applied either). If resume cannot be confirmed (the service disappeared, still paused after resume, etc.) it is treated the same as the existing fail-safe (terminate the process, delete the run dir, `507 record_arm_failed`). `run_id` is not part of the match (it was already fixed at prepare time, so the committed run_id is always the armed one). `operator`/`task` are not part of the match either (they are metadata that does not affect spawning; `session.json`/the manifest are written with the **values from the start request**). On a **mismatch**, the old armed session is disarmed (below; no failure record is written) and it falls back to the **same full synchronous path** as when there was no armed session — a standalone `start()` still completes correctly on its own, as before.
3. **auto-disarm** — if a matching `start` does not arrive within `recording.prepare_disarm_timeout_s` (default **120 s**) while armed, it is automatically disarmed: the paused subprocess is terminated (SIGTERM, since there is no recorded data to flush — a graceful SIGINT flush is unnecessary), the empty run directory and its sibling files (`<run_id>.qos.yaml` / `<run_id>.mcap-storage.yaml` / the recorder log) are removed, and the held rclpy node is destroyed. Disarm **writes no failure record** (it is a deliberate cancel or an expiry, not a recording failure). The same disarm path is also invoked when: `POST /record/stop` is called while armed (otherwise the armed subprocess would leak forever), a `start` turns out to be a mismatch, or `prepare` is called again while already `armed` (**last-wins** — the old one is disarmed before the new one is armed). After a disarm the state is restored to whatever it was before `prepare()` armed it (`created`/`completed`/`failed`/`interrupted`), so disarming never erases visibility of a genuinely-completed prior run.

Trade-offs (explicit):

- **Subscriptions are live while armed** = the same DDS reader load as recording continues the whole time (a paused rosbag2 receives and discards). In setups where SHM is not effective (see "Conditions for single-host SHM" in [deployment_topology](deployment_topology.md)), that is full-copy load, so keeping the arm window short in practice (tying it to explicit operator intent in the UI, or setting `prepare_disarm_timeout_s` short) is assumed. That operational decision (when to call prepare) belongs to `api_orchestrator` / the frontend and is out of scope for this document.
- It adds a prepare/armed/disarm API and state machine. The recorder side is implemented, but `api_orchestrator`'s relaying and the frontend's "prepare" UI action still need a separate design decision and implementation.
- **Unverified (needs real-hardware/Docker verification)**: because FastAPI's sync routes run on Starlette's thread pool, `prepare()`'s rclpy node creation and `start()`'s resume call (`spin_until_future_complete`) can run **on different threads**, with the armed session possibly sitting idle for up to `prepare_disarm_timeout_s` (default 120 s) in between. The existing single-call gate (`_arm_and_resume`) creates, spins, and destroys its node within one call on one thread; this cross-call, cross-thread, long-idle rclpy node reuse is a pattern two-phase start newly introduces, and it cannot be covered by the (rclpy-free) unit tests. That resume is actually fast, and that spinning a node from a thread other than the one that created it works correctly, both need verification in the ROS image.

**Alternative — a same-process implementation via `rosbag2_py.Recorder` — TBD (added 2026-07-09, needs re-examination)**: a resident recorder (keeping the participant/subscriptions warm via rosbag2_py) was previously marked not recommended, on the grounds that it "replaces the proven `ros2 bag record` subprocess behaviour with a hand-rolled implementation — poor risk/benefit." Research has since found that the `ros2 bag record` CLI itself is a thin wrapper that directly calls `rosbag2_py.Recorder` (a pybind11 binding over the C++ `rosbag2_transport::Recorder`) — see `ros2bag/ros2bag/verb/record.py` on the jazzy branch. In other words, calling `rosbag2_py.Recorder` directly from kairos's own process reuses the exact same cache-overflow detection, split, and SIGINT-equivalent flush (`stop()`) as the CLI — it is not "replacing it with a hand-rolled implementation." `pause()` / `resume()` / `is_paused()` are already native methods/options too, with the side benefit of lowering the implementation cost of the two-phase start above. Removing the subprocess spawn (1-3 s) helps part of the start latency, but does not change the DDS discovery/subscription-matching wait itself (orthogonal to, and combinable with, two-phase start). **New open questions**: this API's support on Jazzy is very recent (`rosbag2_py` 0.26.8/0.26.9, 2025-07 to 08) and not yet battle-tested, and because `Recorder`'s constructor calls `rclcpp::init()` itself, it would mean **two ROS contexts coexisting in the same process** — the existing readiness gate's (`_arm_and_resume()`) rclpy context, and the Recorder's own rclcpp context — which is unverified. Revisiting the not-recommended verdict needs real-hardware validation — left as **TBD**, with the implementation decision made together with the user. DDS discovery tuning (initial announcements etc.) shaves little and does not solve it alone (marginal gain).

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
- run states: `created` | `recording` | `stopping` | `completed` | `failed` | `interrupted` | `armed` (the wait state after two-phase start's `prepare()`, until consumed by `start()`. [details](#recording-start-latency-many-topics-and-two-phase-start)).

## Configuration (config)

- The character set of `run_id` is `[A-Za-z0-9_-]+` (path-traversal prevention).
- With `MAX_RECORD_BYTES > 0`, auto-stop on exceeding it.
- `default_topics` / `topic_qos_overrides` come from the `RECORDING_CONFIG` YAML (pattern match). `ROS_DOMAIN_ID` / `DATA_DIR` / `BIND_HOST` are in the shared [config](config.md).
- `recording.prepare_disarm_timeout_s` (default **120 s**): how long a two-phase-start `armed` session is allowed to sit unconsumed by `start()` ([details](#recording-start-latency-many-topics-and-two-phase-start)).

## Design points

- **MCAP is canonical.** Specialized in recording raw data without loss, compliant with ROS 2 standards.
- A run interrupted by a restart, etc., leaves `state=interrupted` in the manifest.
- `run_id` is assigned and passed by `api_orchestrator`. The recorder's responsibility is limited to recording and providing status / manifest; **the source of truth for runs is the orchestrator's SQLite** (Run lifecycle and reconciliation: [api_orchestrator](api_orchestrator.md)).
- Heavy validation and conversion are delegated to `dora_runner` (this container does not do them).
