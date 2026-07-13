<!-- AUTO-GENERATED from docs/specs/ja/deployment_topology.md. Do not edit by hand — edit the Japanese source and run /sync-docs. -->
# Deployment topology — recording from a separate PC without overloading the robot

> Status: design finalized (v1). Japanese is the source of truth (treat it as canonical). The English version `docs/specs/en/deployment_topology.md` is an auto-generated mirror (do not edit it directly). **No authentication required.**

> A placement design for recording a rosbag (MCAP) that includes heavy topics such as images
> from a separate PC (the recording PC), while **not overloading the robot's onboard system at all**. The premise is **wired, same LAN**.
> The existing single-host configuration (`compose.yaml`) works as-is with no changes (this configuration is an additional "split deployment").

## 1. The problem: remote DDS subscription overloads the robot

kairos's 4 ROS services (`rosbag2_recorder` / `topic_monitor` / `topic_probe` / `webrtc_streamer`)
**subscribe** to topics over DDS. If you run these on **a PC separate from the robot**, each service
becomes a **remote reader** on the robot's DDS graph. For heavy topics such as images (`sensor_msgs/Image` at several MB/frame) or
point clouds, this forces the following costs on the robot side:

- **Just having the heavy payload pass through the NIC** incurs kernel/UDP/IP fragmentation CPU and interrupts
  (which does not happen with same-host shared-memory recording).
- On paths where multicast does not work, **per-reader unicast send copies** increase.
- **RELIABLE QoS overhead** (heartbeat / ACKNACK / retransmission) increases **per reader**, and moreover
  **without bound under packet loss**. Images are often RELIABLE by default on the publisher side, hitting the worst case.

Key point (confirmed with codex and investigation): the main cost on the robot side is NOT "re-serialization proportional to the number of readers" (serialization
happens once per sample, the same as local recording). What matters is **the heavy data leaving the robot's NIC itself** and
**per-reader RELIABLE retransmission**. Therefore, **any design where heavy data leaves the robot's DDS onto the network
overloads the robot** (the same applies to plain remote subscription, domain_bridge for heavy topics, and robot-side image_transport compression).

> The competitor OpenLUTRA has this problem: it assumes co-location, the monitor **decodes** all messages including images,
> and matches QoS to the publisher (inheriting RELIABLE for images). Moving to a separate PC pulls the heavy streams twice and triggers a retransmission storm.
> kairos's monitor is non-intrusive from the start (`raw=True`, no decode, automatic best_effort matching), but **the recorder
> subscribes to topics with `ros2 bag record`**, so it is exposed to the same problem when moved to a separate PC. This is the motivation for this design.

## 2. Design approach: make placement explicit and split at the "boundary" (default = Option A)

Divide the services into two groups along the **natural boundary** of whether or not they touch DDS.

| Service | DDS subscription | Placement | Reason |
|---|---|---|---|
| `rosbag2_recorder` | ✓ (`ros2 bag record`, all topics with `--all`) | **Robot** | The largest load source. With local subscription there is no network egress |
| `webrtc_streamer` | ✓ (all camera frames → re-encode) | **Robot** | High bandwidth. Acquire it inside the robot and send only the lightened video |
| `topic_probe` | ✓ (decodes selected topics) | **Robot** | decode requires the full payload |
| `topic_monitor` | ✓ (`raw`, no decode) | **Robot** | The lightest, but it receives all bytes to measure size |
| `api_orchestrator` | ✗ (httpx + SQLite + reads /data) | **Recording PC** | Does not participate in DDS at all |
| `dora_runner` | ✗ (reads MCAP with the `mcap` library. CPU-heavy) | **Recording PC** | Validation/conversion is heavy. Do not run it on the robot |
| `frontend` | ✗ (nginx static + reverse proxy) | **Recording PC** | The browser's single origin |

- The **4 robot-side services** subscribe locally to the robot's DDS graph via **host-networking + ipc:host shared memory**
  (**zero additional network egress**).
- The **3 recording-PC-side services** **do not participate in DDS at all**. Therefore, even running them on a separate PC **cannot overload the robot**.
- **Only lightweight data crosses the boundary**: the monitor's metrics/alerts (JSON/SSE, KB/s), the streamer's
  **already-encoded WebRTC preview** (low rate), and **file sync of recorded MCAP** (not DDS).

> The essence of the guarantee is "**do not place a single DDS reader on the recording-PC side**". Heavy data does not become
> a remote DDS flow. This is ideal for data collection for imitation learning (record at full resolution, check later).

### 2.1 Conditions for single-host SHM (important / partly **TBD**)

The claim above — "local subscription via ipc:host shared memory = zero additional network egress" — holds **only when SHM is actually in effect**. Whether it is depends on the RMW vendor:

- **Fast DDS (kairos default `rmw_fastrtps_cpp`)**: the SHM transport is enabled by default. If the robot-side publishers are also Fast DDS, single-host subscriptions ride SHM with `ipc: host` (already configured). **No extra work.**
- **Cyclone DDS (when switched to `rmw_cyclonedds_cpp`)**: Cyclone's SHM **additionally requires Iceoryx (a resident iox-roudi + `<SharedMemory>` configuration, and generally an SHM-enabled source build)**, which **kairos does not bundle**. On a Cyclone robot, therefore, **every local reader receives a full loopback-UDP copy even on the same host**, and large samples (images etc.) are IP-fragmented. When fragments are lost under load, the receiving side's decode can raise errors like `sequence size exceeds remaining buffer` (CDR length overrun).
- Verifying empirically: with kairos up and subscribing, watch the receive bandwidth on `lo` on the host (e.g. `sar -n DEV 1`). If it grows by camera bandwidth × N as you add subscribing services, SHM is not in effect. Fast DDS SHM segments can be checked with `ls /dev/shm`.

**Mitigating while staying on Cyclone (without SHM) — possible with kairos alone:**

1. **Enlarge receive buffers** (the first move against fragment loss): on the host, `sysctl -w net.core.rmem_max=67108864` (raise `rmem_default` too) + specify `<Internal><SocketReceiveBufferSize min="16MB"/></Internal>` in the `CYCLONEDDS_URI` XML (it reaches every ROS service via the `/config` mount; see `CYCLONEDDS_URI` in [config](config.md)).
2. **Reduce concurrent readers**: while load is critical (e.g. during teleop), reduce readers other than the recorder (the monitor's `POST /metrics/pause`, close previews — they auto-stop after 60 s idle — and don't use the probe). This cuts the number of full copies itself.
3. **Subscribe to compressed camera topics only** (the default). Don't drag in raw sibling topics via `--all` etc.

**TBD**: full Cyclone + Iceoryx support (bundling iox-roudi in compose and preparing the XML; note **the robot-side nodes also need SHM enabled**, so kairos alone cannot complete it) is undecided due to the high effort. Where both sides can be unified on Fast DDS, that is the lowest-effort way to make SHM work.

**TBD (architecture change, needs user judgment; added 2026-07-09): consolidate kairos's own duplicate subscriptions into one.** Mitigation ② above ("reduce concurrent readers") is an operational workaround for when load is critical. As a permanent fix, changing the design so that recorder / topic_monitor / webrtc_streamer / topic_probe — which currently each subscribe to the same image topics independently — instead have a single process subscribe once and fan the data out in-process for all four purposes would cut kairos's own full-copy count by up to 4x, regardless of whether SHM is in effect (it helps without waiting for Iceoryx support, and is achievable with kairos alone). However, this is a change of a scale that breaks the current "1 folder = 1 container" convention (four independent containers; see [README](../../../README.md)), so it needs user judgment. **ROS 2 composition (`rclcpp_components` / component containers) cannot be used for this** (researched: rclpy has no composition / intra-process comms support at all — see `ros2/rclpy#575`, `#599`. And even if it did, composition only achieves zero-copy when the publisher and subscriber can be placed in the same process — the publisher here, the robot-side camera driver, is an existing process outside kairos's control, so there is no way to bring it into the container in the first place).

## 3. Option A (default): edge recording (place the recorder on the robot)

### 3.1 Configuration files
- `compose.robot.yaml` … the 4 robot-side services only (reuses definitions from `compose.yaml` via `extends`).
- `compose.recording.yaml` … the 3 recording-PC-side services only.
- **Split into 2 files rather than profiles**: with 1 file + profiles it is easy to "accidentally start a DDS reader on the recording PC".
  **The recording PC's file does not contain any DDS service in the first place**, so the accident cannot happen.

### 3.2 Procedure
Robot:
```bash
# Place this repository on the robot; match the robot's ROS 2 graph via .env
cp .env.split.example .env   # edit ROS_DOMAIN_ID / RMW_IMPLEMENTATION / ROS_DISTRO
make robot-up                # or: docker compose --env-file .env -f compose.robot.yaml up -d --build
```
- `.env.split.example` has a **"ROS 2 graph (robot side)" section** where you set `ROS_DOMAIN_ID` /
  `RMW_IMPLEMENTATION` / `ROS_DISTRO` (and optionally `CYCLONEDDS_URI` / `FASTRTPS_DEFAULT_PROFILES_FILE` /
  `MSGS_OVERLAY_DIR` / `BIND_HOST`). For `ROS_DISTRO`, **the .env value beats the Makefile default
  (jazzy)** (the image tag/base switches too).
- Networking: all four robot-side services run with `network_mode: host` + `ipc: host` (inherited via
  `extends` from `compose.yaml`). The HTTP APIs bind `BIND_HOST` (default `0.0.0.0`) and must be
  reachable from the recording PC across the LAN (trusted-LAN premise; narrow it to the robot's LAN
  interface IP if you must).
- A robot using the gitignored `config/local/<robot>/` resolves even under plain `docker compose`
  (without `make`): each service **resolves the given path committed → local at startup**. If the
  robot's clone lacks the local tree itself, publish it from the recording PC with `make push-config`
  (below).

Recording PC:
```bash
cp .env.split.example .env
# Set ROBOT_IP in .env to the robot's LAN IP. *_HOST references it.
docker compose -f compose.recording.yaml up -d --build    # or: make recording-up
```

### 3.3 Seams in the code (default localhost, backward compatible)
- orchestrator: **make the downstream services' hosts env-driven** (`RECORDER_HOST` / `TOPIC_MONITOR_HOST` /
  `WEBRTC_HOST` / `TOPIC_PROBE_HOST` / `DORA_RUNNER_HOST`, default `localhost`).
  Implementation: `libs/kairos_common/settings.py` + `services/api_orchestrator/app_factory.py`.
- nginx: **make the upstream hosts env-driven** (`API_HOST` / `WEBRTC_HOST` / `PROBE_HOST`, default `127.0.0.1`).
  `services/frontend/default.conf.template`. On the recording PC, set `WEBRTC_HOST` / `PROBE_HOST` to the robot IP.
- `DORA_RUNNER_HOST` stays local to the recording PC (dora is heavy and co-located with the orchestrator).

### 3.4 The MCAP boundary (important): **post-recording rsync**, not NFS
The recorder writes MCAP to **the robot's disk**. dora (CPU-heavy) reads a **PC-local copy** on the recording PC.

- **Do not mount robot:/data over NFS and let dora read it directly**. If dora scans large MCAP,
  the robot ends up supplying disk/network, which **overloads the robot if recording is in progress** (contrary to the intent of this design).
- The default is `make import-runs` (`deploy/sync/import_runs.sh`): rsync from the robot **only runs that are finalised (have `metadata.yaml`)**
  (`--partial --append-verify`, bandwidth-limitable with `BWLIMIT`). It is idempotent and can be run on a timer.
  In-progress runs are not half-copied.
- Do not let the recorder POST files (to avoid coupling upload failures to the recording lifecycle).
- Note: `dora_runner`'s `dataset_export` **moves** files from `recorded/`
  (`dataset_export.py`). **It is safe against a PC-local copy**, but **destructive if it points at robot storage or a read-only NFS**. Always run it against an already-imported PC-local copy.

## 4. Option B (alternative): robot-side Zenoh gateway (live full-data recording from a separate PC)

Only when you want to handle **full data live** on a separate PC (place the recorder on a separate PC). It is more complex than Option A, with
the trade-off of placing one heavy reader/gateway on the robot side.

- Place one `zenoh-bridge-ros2dds` on the robot and **pin the robot's DDS to localhost**
  (`NetworkInterfaceAddress=lo` and `AllowMulticast=false` in CycloneDDS's `cyclonedds.xml`, or
  `ROS_AUTOMATIC_DISCOVERY_RANGE=LOCALHOST` on ROS 2 Iron+).
- Then **the robot's publisher sees only one local reader (the bridge)**. Heavy data crosses the LAN **just once over a single
  TCP/QUIC session** (no per-remote-reader fan-out and no RTPS retransmission storm).
- Narrow the topics with the bridge's allow/deny, and **thin out only the cameras** with `--max-frequency "<regex>=<hz>"` (e.g. the robot
  full, the remote 10Hz). Compress **only when the link is the bottleneck** (off by default because it consumes robot CPU; thinning is cheaper).
- Skeleton: `config/zenoh/` (bridge configuration) and `config/cyclonedds-localhost.xml` are provided as templates (environment tuning required).
- **What you must not do (hidden overload)**: plain remote subscription of heavy topics / domain_bridge for heavy topics /
  robot-side image_transport compression solely for remote recording / republisher nodes.

## 5. Caveats (pitfalls)

- **Time synchronization**: use chrony/PTP/NTP on the robot and the PC. Message stamps come from the robot, but UI/event times,
  transfer times, and validation-report times depend on each host's clock.
- **WebRTC**: it works under this design's premise (same LAN, wired). What nginx relays is **only signaling**;
  RTP media is P2P. The browser must **reach the robot IP directly** (satisfied on the same LAN).
  Crossing NAT/VPN requires STUN/TURN separately (aiortc currently offers host candidates only).
- **config synchronization**: editing the orchestrator's Settings tab writes to **the recording PC's /config**. Meanwhile recorder/monitor read
  **the robot's /config** (the recorder's `start_paused` / `max_cache_size_mb` / QoS come from the robot-side config;
  the selection of topics to record is passed in the start payload, so it is separate). **To change the recorder's behavior, edit the robot's config/
  and `make robot-config-reload`**. The gitignored `config/local/<robot>/` does not travel with git, so publish the
  recording PC's copy to the robot's clone with **`make push-config`** (`deploy/sync/push_config.sh`, one-way
  PC→robot rsync; `DELETE=1` also syncs deletions). It is safe to treat config/ as a deploy-time asset.
- **Proxy**: when the recording PC sits behind a corporate proxy, Docker injects `HTTP(S)_PROXY` into every
  container, and LAN calls to the robot plus healthchecks get sucked into the proxy and fail. All kairos HTTP is
  LAN-internal, so compose hands every service `NO_PROXY` (default `localhost,127.0.0.1`; `.env.split.example`
  also includes `ROBOT_IP`), and the orchestrator's internal httpx client runs with `trust_env=False`, never
  reading the proxy environment variables at all.
- **Robot power-off**: the host (recording PC) side does not go down. Review / Validation / Datasets / Settings
  keep working entirely locally, and Collect/Monitor explicitly say "robot offline" (the orchestrator relays its
  monitor-SSE-bridge up/down as a `bridge` event to the UI; the header's green "DDS connected" requires the bridge
  to be up). Robot-bound calls fail fast with a 1s connect budget (/topics 503s in about 2s; nginx's /webrtc and
  /probe use `proxy_connect_timeout 3s`). This supports taking a laptop away and reviewing data later.
  Caveat: the recordings list (Review) reads the DB, so a run **recorded by a different orchestrator** does not appear
  even after `make import-runs` brings its files in (runs recorded by this same PC's orchestrator do).
- **Permissions**: the MCAP the recorder creates is owned by root. Align UID/GID/umask so the import side (the rsync user) can read it.
- **Security**: all services are unauthenticated on the premise of a trusted LAN. Note that splitting increases the exposed surface (not exposed to the internet).

## 6. Summary

The only structural solution to "not overloading the robot" is **to not let heavy data leave the robot's DDS onto the network**.
The default **Option A (edge recording + placement split)** guarantees this by not placing any DDS reader on the recording-PC side.
Use **Option B (robot-side Zenoh gateway + DDS pinned to localhost)** only when you need live full data from a separate PC.
The single-host configuration (`compose.yaml`) works as before with nothing changed.
