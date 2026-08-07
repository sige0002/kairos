<!-- AUTO-GENERATED from docs/specs/ja/rosbag2_recorder.md. Do not edit by hand — edit the Japanese source and run /sync-docs. -->

# rosbag2_recorder specification

> Status: design finalized (**v2 = capture store**). Based on `fig_const/rosbag2recorder.png`, with unspecified items finalized as recommended design. Japanese is the source of truth (treat it as canonical). The English version `docs/specs/en/rosbag2_recorder.md` is an auto-generated mirror (do not edit it directly). **No authentication is required.**

A container that **formally records ROS 2 topics to MCAP**. The official raw-data recording path (**canonical**). This is the only container that records raw data.

[capture_store](capture_store.md) is canonical for the output layout, the sidecars and the id scheme; this document states how the recorder side satisfies it.

## Role

- Specializes in recording the selected ROS 2 topics to MCAP without loss.
- 1 container = 1 recording session (only one recording at a time).
- **It issues the `capture_id`** (v2). A UUIDv7 is assigned at prepare / start time, and from then on that id alone carries the capture's identity.

## Input

- Selected ROS 2 topics (an explicit list, or `"all"`)
- record config (compression / split / QoS, etc.)
- `run_id` (a **display name** assigned and passed by the orchestrator) / `data_dir`
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

**This is the single source of truth for the recorder's HTTP interface** (fixed in v2).

- `POST /record/prepare` (two-phase start. [details](#recording-start-latency-many-topics-and-two-phase-start)) — same body shape as `POST /record/start`.
  → `201 { run_id, capture_id, state: "armed", arming, disarm_at }`. A **matching** re-prepare while armed extends the deadline instead of respawning, and returns the **existing session's `run_id` / `capture_id`** plus the new `disarm_at` (keep-alive).
- `POST /record/start` — body:
  ```json
  {
    "topics": ["..."] ,
    "run_id": "a display name assigned and passed by the orchestrator",
    "compression": "none",
    "split": { "max_size_mb": null, "max_duration_s": null },
    "qos_default": { "reliability": "best_effort", "durability": "volatile", "depth": 10 },
    "qos_overrides": { "/topic": { "reliability": "reliable", "durability": "transient_local", "depth": 1 } },
    "operator": null, "task": null, "robot": null
  }
  ```
  → `201 { run_id, capture_id, state, started_at, arming? }`. The type of `topics` is `string[] | "all"`. `robot` is optional (falling back to `robot_name` in `RECORDING_CONFIG` when omitted). If a matching `armed` session exists from just before, this becomes the fast path that only resumes it ([details](#recording-start-latency-many-topics-and-two-phase-start)).
- `POST /record/stop` — **idempotent**. Recording → stop and `200`; armed → disarm and `200` (idle-equivalent); idle → `200` (returns the current state).
  - **The stop signal escalates in three stages**: SIGINT (the regular path — rosbag2 flushes and writes `metadata.yaml`) → SIGTERM after `STOP_TIMEOUT_S` → **SIGKILL** after another `STOP_TIMEOUT_S` (all aimed at the process group). The first two are catchable, so leaving an ignoring recorder alone produces **"the recorder says stopped while the bag process keeps writing"** (appends to a finalised capture). SIGKILL cannot be caught or ignored, so it always lands; the final wait (`KILL_TIMEOUT_S`) can come up empty only in uninterruptible sleep (D state), where the process dies the instant its I/O returns — not a failed kill, so we log an ERROR and move on instead of waiting. A SIGKILL death is not in the clean-returncode set, so finalise lands on `interrupted` / `failed` via the `has_bag` discriminator.
  - A session that is **`recording` yet has no subprocess handle** is treated as an invariant violation: instead of returning the current state, stop **logs an ERROR and finalises from the facts on disk** (`ended_at` = now). Previously this path returned the state unchanged, so stop no-opped forever and the console's post-stop status re-read stayed active (the infinite `stop_not_confirmed` retry).
- The responses of `GET /record/status` / `POST /record/stop` — `{ state, run_id, capture_id, live_capture_ids, disarmed_capture_id?, started_at, message_count, bytes, topics: [], arming, dropped_messages, integrity, disk_free_bytes, git_sha }` (`disk_free_bytes` is the free space of the **recorder's OWN data-dir** — the robot's disk in the split deploy; `null` when it cannot be statted. `git_sha` is the **build identity baked into the image** (`KAIROS_GIT_SHA`; `null` when not baked). 2026-08-05). The start request also accepts an optional `console_stamp` (console-side build identity); the recorder writes it, together with its own `{git_sha, config_sha256}`, into the manifest's **`extra.stamp`** (an additive write — no sidecar schema change — that makes every capture traceable to the exact PAIR of builds that produced it) (`dropped_messages` / `integrity`: see [drop detection](#drop-detection-recording-cache-integrity)). While `state: "armed"`, `run_id`/`capture_id`/`topics` refer to the armed session's, `message_count`/`bytes` are `0`, and `started_at` is `null`.
  - **`live_capture_ids`** — the definitive list of captures for which the recorder is **still the sole writer**. Non-empty under `armed` / `recording` / `stopping` (**armed included**), `[]` otherwise. The orchestrator's rebuild uses **only this array** to exclude live captures ([capture_store](capture_store.md) §8.2 rule 1).
  - **A response with the array missing is treated as "the recorder is unreachable", not as "an empty live set".** An armed capture has no manifest yet, so mistaking the live set makes rebuild turn a half-written directory into a row.
  - The singular `capture_id` **keeps pointing at the most recent capture** even after terminal (it is never set to `null`), so that a stop response can name "which one just ended".
  - **`disarmed_capture_id`** — names the discarded capture, but only when a `stop` cancelled an armed session. It cannot ride on `capture_id` (that one points at the most recent **settled** capture and must not be overwritten by a cancel), yet the caller needs to know that "the id I asked for will never appear". `null` on every other stop.
- `GET /record/metadata` — the most recent capture's metadata. `{ capture_id, run_id, manifest, rosbag2_metadata, bytes }`. A corrupt manifest returns **`500 manifest_corrupt`**, not `404` (never report "cannot be read" as "does not exist").
- `GET /healthz` / `GET /readyz`
- Errors: an unwritable `/data/objects` or insufficient free space rejects recording (`507`-equivalent). A duplicate start / duplicate prepare returns `409`. The `details` of a failed start's `507` **always includes the `capture_id`**. `failed_start_record_error` is attached only when writing the sidecar itself failed.

### Startup recovery (classifying abandoned arms / starts)

At startup, when the recorder finds a directory directly under `objects/` **with no manifest it wrote**, it classifies it as an arm / start it abandoned:

- **A bag is present** → synthesize a manifest with `state=interrupted` (the `run_id` may be synthesized as `run_recovered_…`). It uses the same `unknown_*` spellings as the live path.
- **Empty** → delete it together with its sibling files and leave a warning.

For those that carry a manifest with `state ∈ {recording, stopping}`, the count and size are re-measured from disk before the terminal state is decided. There are three terminal states (`completed` / `interrupted` / `failed`), and the presence of a bag is the shared discriminator (kept consistent with [capture_store](capture_store.md) §8.2 rule 2).

## Start-time drop mitigation (start-paused readiness gate, optional)

After spawn, `ros2 bag record` does not establish a subscription to the target topics until DDS discovery → subscription match completes, and VOLATILE/best_effort messages during that window are not recorded (`start_delay_s` is for publisher warm-up and is a different concern from this lag).

Enable the mitigation with `recording.start_paused: true` (default `false`): start the recorder with **`--start-paused`** → wait until the subscriptions to the target topics are established on the graph (up to `subscription_ready_timeout_s`) → call the recorder's `~/resume` and only then return "recording". This keeps **all subscriptions live from resume onward**. **Fail-safe**: if resume cannot be confirmed, fail the start visibly (`507 record_arm_failed`) — never leave it paused and silently recording nothing. The readiness check and resume use rclpy + a rosbag2 service and run only in the ROS image (outside CI), so they are intended to be **enabled per deployment after verification**. For single-shot/latched topics that require t0, making the publisher side transient_local is a complementary measure.

Resume is done via the **rosbag2 `~/resume` service**, so it does not depend on the interactive SPACE key (which requires a pseudo-TTY/pty). The recorder is always passed `--disable-keyboard-controls` to disable keyboard control (removing needless overhead and the TTY dependency).

#### The arming observational snapshot (`arming`, revised 2026-07-27)

Targets that are not being captured are split **by cause**, because the UI states this as fact: merging them makes it declare a topic that Monitor shows at 30 Hz "not publishing" (and sends the operator off to fix the wrong thing).

- `matched_topics` — a publisher exists AND the recorder has subscribed.
- `missing_topics` — **no publisher** on the graph (genuinely not publishing).
- `unsubscribed_topics` — **it IS being published**, the recorder just has not subscribed yet (DDS discovery catching up). Additive field: an older frontend that does not know it simply shows one fewer category.

The readiness gate's wait condition is unchanged (until `missing ∪ unsubscribed` is empty, at most `subscription_ready_timeout_s`) — the split only changes observational granularity.

The snapshot is **not frozen at the first arm**. An `armed` session stays armed for a long time (the console's pre-arm keep-alive), so the graph is re-read through the held rclpy node on `GET /record/status`, on a matching re-prepare (keep-alive), and at the fast start's resume (a pure read — no subscriptions, no spin; a failure keeps the previous snapshot). This makes the display while `armed` always current readiness, and the value frozen for the recording "**start-time**" coverage rather than "**first-prepare-time**" coverage.

### Recording-start latency (many topics) and two-phase start

**Symptom**: with many topics (e.g. 4 cameras + 27 numeric = 31 topics), it takes several seconds from `POST /record/start` until writing actually begins. The breakdown: ① the **subprocess spawn** of `ros2 bag record` (Python CLI + rclcpp init, 1–3 s), ② the new DDS participant's **discovery + subscription matching for the target topics** (proportional to topic count and graph size; longer on a busy graph), ③ writer init. The UI's "recording (red)" lights on start acceptance, so with `start_paused` disabled this appears as time where it is "**red but not yet recording**" (with it enabled, the same time appears as the start-response wait — a different presentation of the same root cause).

**Decided and implemented (v1): two-phase start (prepare → resume).** Building on the existing start-paused readiness gate, the spawn and matching are finished **before the actual start action**.

1. `POST /record/prepare` — spawns the recorder with **`--start-paused`** **unconditionally**, regardless of the `recording.start_paused` config value, and waits until subscription matching is complete (the same readiness-gate logic, and the same application points for `start_delay_s`/`post_discovery_delay_s`). The matched `~/resume` / `~/is_paused` service clients and the rclpy node are **kept, not discarded** (to make the later resume fast — recreating them here would pay the DDS-participant-creation and service-discovery cost again, defeating the point of two-phase start). Once done, it waits in the **`armed`** state. The `capture_id` and `run_id` are fixed here (rosbag2 opens `--output` = `objects/<capture_id>` at spawn time, so they stay fixed afterward). Response: `201 { run_id, capture_id, state: "armed", arming, disarm_at }` (`arming` reuses the existing observational snapshot ([above](#the-arming-observational-snapshot-arming-revised-2026-07-27)); a keep-alive re-prepare reuses the subprocess but **re-reads the snapshot**; `disarm_at` is the auto-disarm deadline below, a different concept from the existing `resume_at` — the single-call gate's own readiness-timeout deadline). Returns `409 already_recording` while recording/stopping (`armed` is excluded from `_ACTIVE_STATES`, which is what keeps it from blocking a normal `start`, but `prepare` itself cannot be called while recording).
2. `POST /record/start` — if an armed session exists AND the **spawn-affecting fields** (the normalised topic selection, `compression`, `split`, `qos_default`, `qos_overrides`) **match** the prepare-time request, this is the fast path: just call `~/resume` via the held clients (**no re-spawn, no discovery wait** — `start_delay_s`/`post_discovery_delay_s` are not re-applied either). If resume cannot be confirmed (the service disappeared, still paused after resume, etc.) it is treated the same as the existing fail-safe (terminate the process, delete the capture directory, `507 record_arm_failed`). `run_id` is not part of the match (it was already fixed at prepare time, so the committed `run_id` / `capture_id` are always the armed session's). `operator`/`task` are not part of the match either (they are metadata that does not affect spawning; `object_manifest.json` is written with the **values from the start request**). On a **mismatch**, the old armed session is disarmed (below; no failure record is written) and it falls back to the **same conventional full synchronous path** as when there was no armed session — a standalone `start()` still completes correctly on its own, as before.
3. **auto-disarm** — if a matching `start` does not arrive within `recording.prepare_disarm_timeout_s` (default **120 s**) while armed, it is automatically disarmed: the paused subprocess is terminated (SIGTERM, since there is no recorded data — a graceful SIGINT flush is unnecessary), the empty `objects/<capture_id>/` and its sibling files (`<capture_id>.qos.yaml` / `<capture_id>.mcap-storage.yaml` / `<capture_id>.recorder.log`) are removed, and the held rclpy node is destroyed. The cancelled `capture_id` is thrown away and never appears again (on a disarm via stop, the response's `disarmed_capture_id` names it). Disarm **writes no failure record** (it is a deliberate cancel or an expiry, not a recording failure). The same disarm path is also invoked when: `POST /record/stop` is called while armed (otherwise the armed subprocess would leak forever), a `start` turns out to be a mismatch, or a **mismatching** `prepare` arrives while already `armed` (**last-wins** — the old one is disarmed before the new one is armed).
4. **keep-alive (matching re-prepare = extend)** — a **matching** `prepare` while already `armed` does not disarm/respawn; it only extends the auto-disarm deadline (the response carries the existing armed session's `run_id` / `capture_id` and the new `disarm_at`; the orchestrator adopts the returned values). A caller (the frontend's pre-arm engine) that keeps re-preparing before the deadline keeps the session armed with zero process churn (~10 ms measured). The extend also bumps the armed generation — closing the ABA where a cancelled-but-already-waiting-on-the-lock old timer callback would otherwise disarm the extended session. After a disarm the state is restored to whatever it was before `prepare()` ran (`created`/`completed`/`failed`/`interrupted`) — so that a capture that had genuinely completed before the arm does not lose its visibility.

Trade-offs (explicit):

- **Subscriptions are live while armed** = the same DDS reader load as recording continues the whole time (a paused rosbag2 receives and discards; measured: 78-96% of recording CPU). In setups where SHM is not effective (see "Conditions for single-host SHM" in [deployment_topology](deployment_topology.md)), that is full-copy load, so the arm window is kept short by tying it to operator intent. **Implemented (2026-07-14)**: the frontend (Collect screen) pre-arms + keeps alive only while the tab is visible AND the phase is ready/result; leaving lets `prepare_disarm_timeout_s` clean it up. A robot with no receive-side headroom disables the whole behaviour with `recording.pre_arm: false` ([config.md](config.md)) — the recorder itself never reads that flag; the frontend does.
- It adds a prepare/armed/disarm API and state machine. The recorder, `api_orchestrator`'s relaying (`POST /api/v1/record/prepare`), and the frontend's pre-arm engine are all **implemented (2026-07-14)**.
- **Field-verified (2026-07-14, Docker stack / Jazzy)**: the previously-flagged concern — `prepare()` and `start()` running on **different Starlette thread-pool threads** with a long idle in between, reusing the held rclpy node — is resolved: a `start()` after **65 s of armed idle resumed in 16 ms** (1390 messages recorded, integrity ok). The matching-re-prepare extend measured ~10 ms, and TTL-expiry auto-disarm was confirmed working.

**Alternative — a same-process implementation via `rosbag2_py.Recorder` — TBD (added 2026-07-09, needs re-examination)**: a resident recorder (keeping the participant/subscriptions warm via rosbag2_py, permanently erasing the spawn cost) was previously marked not recommended, on the grounds that it "replaces the proven `ros2 bag record` subprocess behaviour with a hand-rolled implementation — poor risk/benefit." Research has since found that the `ros2 bag record` CLI itself is a thin wrapper that directly calls `rosbag2_py.Recorder` (a pybind11 binding over the C++ `rosbag2_transport::Recorder`) — see `ros2bag/ros2bag/verb/record.py` on the jazzy branch. In other words, calling `rosbag2_py.Recorder` directly from kairos's own process passes straight through to the exact same cache-overflow detection, split, and SIGINT-equivalent flush (`stop()`) as the CLI — it is not "replacing it with a hand-rolled implementation." `pause()` / `resume()` / `is_paused()` are already native methods/options too, with the side benefit of lowering the implementation cost of the two-phase start above. Removing the subprocess spawn (1-3 s) helps part of the start latency, but does not change the DDS discovery/subscription-matching wait itself (orthogonal to, and combinable with, two-phase start). **New open questions**: this API's support on Jazzy is very recent (`rosbag2_py` 0.26.8/0.26.9, 2025-07 to 08) and not yet battle-tested, and because `Recorder`'s constructor calls `rclcpp::init()` itself, it would mean **two ROS contexts coexisting in the same process** alongside the existing readiness gate's (`_arm_and_resume()`) rclpy context — which is unverified. Those are the two points. Overturning the not-recommended verdict therefore needs real-hardware validation — left as **TBD**, with the implementation decision made together with the user. DDS discovery tuning (initial announcements etc.) shaves little and does not solve it alone (marginal gain).

## Drop detection (recording cache integrity)

`ros2 bag record` accumulates received messages in an **in-memory cache** (`--max-cache-size`, default 100 MiB) that a writer thread flushes to disk. Under bursts, slow storage, or CPU constraints, **if writing cannot keep up the cache overflows and the excess is silently discarded** (rosbag2 prints `Total lost: N` to stderr at shutdown). This is the main data-loss path during recording.

- **Cache tuning**: `recording.max_cache_size_mb` (MiB) overrides `--max-cache-size`. `0` omits the flag and uses the rosbag2 default (100 MiB). Larger values increase burst tolerance. The bundled real-robot profile sets **512**. Because of double buffering the worst-case RAM is about `2×`, and free RAM is preflighted before start (`507 insufficient_memory` if short).
- **Drop detection**: the recorder's stdout/stderr is captured to a **file** (`objects/<capture_id>.recorder.log`, a sibling of the capture directory) and scanned for `Total lost: N` at finalise. **Because it is a file, not a pipe**, it does not cause a fixed-size-buffer flush stall at stop time (pipe-stall) and the log can be scanned afterward (impossible with inherit-to-container-log). The result is exposed as `dropped_messages` (the count dropped; `null` means unknown) and `integrity` (`ok` / `dropped` / `failed` / `unknown`) in `object_manifest.json` and `GET /record/status`. Even a cleanly completed recording that overflowed is stated explicitly as `completed` with `integrity=dropped` (= data was lost).
- The log is moved into the capture directory after finalise (`objects/<capture_id>/recorder.log`) so it can be audited alongside the bag.

## Output / artifacts

For the layout conventions see [capture_store](capture_store.md) §2. What the recorder writes is:

- `/data/objects/<capture_id>/<capture_id>_*.mcap` (sequentially numbered when split; rosbag2 derives it from the `--output` directory name)
- `metadata.yaml` (the rosbag2 standard; kairos does not modify it)
- **`object_manifest.json`** (kairos-specific, v2): v1's `manifest.json` + `session.json` merged into one. capture_id / source_instance_id / run_id / state / operator / task / robot / the selected topics (type, QoS) / started_at, ended_at (UTC) / compression / split / error / `dropped_messages` / `integrity` / `digest_state` / `files` / `manifest_digest`. The schema is [capture_store](capture_store.md) §3.
  - **The recorder is the sole writer until finalize**, and hands it over with `digest_state=pending`. From then on the orchestrator's digest job is the sole writer (§3.3).
  - **The source of truth for a capture is this sidecar, not the DB.** `kairos.db` is merely an index that can be rebuilt from it (v1's "SQLite is the single source of truth, the manifest is for auditing" is withdrawn).
- `recorder.log` (moved into the capture directory after finalise): the recorder process's stdout/stderr. The source for analyzing `Total lost` (cache overflow), etc.
- `objects/<capture_id>.failed.json`: the record of a start where not one byte of bag came into existence (§3.4). It is **a sibling file rather than a directory** in order to hold the invariant "a directory directly under `objects/` = bytes were written".
- Temporary sibling files during recording: `objects/<capture_id>.qos.yaml` / `.mcap-storage.yaml` / `.recorder.log` (cleaned up at finalise / disarm).
- capture states: `recording` | `stopping` | `completed` | `failed` | `interrupted` (these five are what a manifest can ever say). The recorder's internal session state adds `created` and `armed` on top of those (the wait state after two-phase start's `prepare()`, until it is consumed by `start()`. [details](#recording-start-latency-many-topics-and-two-phase-start)). `delete_pending` / `discarded` / `deleted` exist only in the DB and the ledger — **a manifest never says "deleted"**.

## Configuration (config)

- The character set of `run_id` is `[A-Za-z0-9_-]+`. In v2 run_id is no longer a directory name (the path is `objects/<capture_id>`), but the orchestrator keys a UNIQUE column on it and shows it to the operator, so the character-set guarantee stays.
- With `MAX_RECORD_BYTES > 0`, auto-stop on exceeding it. `MAX_RECORD_SECONDS` (default 600, `0`=disabled) is the wall-clock cap of a single recording — a disk-protection backstop for orphan recordings that no one stops. Both auto-stops are settled as a normal completed by the orchestrator's lazy reconciliation (status polling).
- `default_topics` / `topic_qos_overrides` come from the `RECORDING_CONFIG` YAML (pattern match). `ROS_DOMAIN_ID` / `DATA_DIR` / `BIND_HOST` are in the shared [config](config.md).
- `recording.prepare_disarm_timeout_s` (default **120 s**): how long a two-phase-start `armed` session is allowed to sit untouched by either a `start()` or a keep-alive re-prepare ([details](#recording-start-latency-many-topics-and-two-phase-start)).
- `recording.pre_arm` (default **true**): an operational flag **read by the frontend** — whether the Collect screen runs pre-arm + keep-alive while ready. The recorder itself never reads it ([config.md](config.md)).

## Design points

- **MCAP is canonical.** Specialized in recording raw data without loss, compliant with ROS 2 standards.
- A capture interrupted by a restart or the like leaves `state=interrupted` in the manifest.
- **The `capture_id` is assigned by the recorder** (UUIDv7). The `run_id` is a **display name** assigned and passed by `api_orchestrator`, used neither in paths nor as an API key. The recorder's responsibility is limited to recording and to serving status / manifest (the capture lifecycle and reconciliation are [api_orchestrator](api_orchestrator.md); the durability conventions are [capture_store](capture_store.md)).
- **Recording depends on nothing else.** start / stop must never depend on the completion of the ledger, digests, or rebuild ([capture_store](capture_store.md) safety principle 5). Even with a full disk, even with a corrupted DB, the recording path alone keeps working.
- Heavy validation and conversion are delegated to `dora_runner` (this container does not do them).
