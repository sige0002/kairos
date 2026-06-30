<!-- AUTO-GENERATED from docs/specs/ja/deployment_topology.md. Do not edit by hand — edit the Japanese source and run /sync-docs. -->
# Deployment topology — recording from a separate PC without overloading the robot

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

## 3. Option A (default): edge recording (place the recorder on the robot)

### 3.1 Configuration files
- `compose.robot.yaml` … the 4 robot-side services only (reuses definitions from `compose.yaml` via `extends`).
- `compose.recording.yaml` … the 3 recording-PC-side services only.
- **Split into 2 files rather than profiles**: with 1 file + profiles it is easy to "accidentally start a DDS reader on the recording PC".
  **The recording PC's file does not contain any DDS service in the first place**, so the accident cannot happen.

### 3.2 Procedure
Robot:
```bash
# Place this repository on the robot, matching the robot's DDS
ROBOT=airoa_hsr ROS_DOMAIN_ID=<robot's domain> RMW_IMPLEMENTATION=<matches the robot> \
  docker compose -f compose.robot.yaml up -d --build      # or: make robot-up
```
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
- **config synchronization**: editing the orchestrator's Config tab writes to **the recording PC's /config**. Meanwhile recorder/monitor read
  **the robot's /config** (the recorder's `start_paused` / `max_cache_size_mb` / QoS come from the robot-side config;
  the selection of topics to record is passed in the start payload, so it is separate). **To change the recorder's behavior, edit the robot's config/
  and `make config-reload`**. It is safe to treat config/ as a deploy-time asset.
- **Permissions**: the MCAP the recorder creates is owned by root. Align UID/GID/umask so the import side (the rsync user) can read it.
- **Security**: all services are unauthenticated on the premise of a trusted LAN. Note that splitting increases the exposed surface (not exposed to the internet).

## 6. Summary

The only structural solution to "not overloading the robot" is **to not let heavy data leave the robot's DDS onto the network**.
The default **Option A (edge recording + placement split)** guarantees this by not placing any DDS reader on the recording-PC side.
Use **Option B (robot-side Zenoh gateway + DDS pinned to localhost)** only when you need live full data from a separate PC.
The single-host configuration (`compose.yaml`) works as before with nothing changed.
