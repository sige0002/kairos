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

**Decision (needs implementation; added 2026-07-09): do not pursue Iceoryx; generalize `rmw_zenoh_cpp` as a third RMW choice.** Prioritizing robot-side generality (the RMW vendor can differ per model), we decided on a policy of aiming for single-host SHM via Zenoh's own shared-memory transport rather than a Cyclone + Iceoryx integration.
- The package is confirmed available from apt for Jazzy (Noble) (`ros-jazzy-rmw-zenoh-cpp`, packages.ros.org, with `ros-jazzy-zenoh-cpp-vendor` bundled). It needs to be added to the 4 ROS-side services' Dockerfiles as an `RMW_IMPLEMENTATION` choice on par with the existing `rmw_fastrtps_cpp` / `rmw_cyclonedds_cpp` (currently only Cyclone is bundled, at the `ros-${ROS_DISTRO}-rmw-cyclonedds-cpp`-equivalent line in `services/*/Dockerfile`).
- **Zenoh is also not "just an env switch"**: unlike DDS it is not automatic peer discovery, and **a router process (`rmw_zenohd`), the counterpart of Iceoryx's `iox-roudi`, must be separately resident**. It is work on the scale of adding one service to compose — lighter than Iceoryx (external source build + XML preparation), but not "no extra work".
- It is a different thing from the `zenoh-bridge-ros2dds` (a DDS↔Zenoh **gateway** for cross-host) used in Option B in §4 above. What is added this time is `rmw_zenoh_cpp` (**the RMW implementation itself**, a same-host in-host transport that does not go through DDS); the two can coexist independently.
- Unconfirmed (settle before implementation): whether Zenoh's SHM plugin actually achieves zero-copy under kairos's container configuration (`network_mode: host` / `ipc: host`), which container to bundle the router in, and how to place the settings point equivalent to the existing `CYCLONEDDS_URI` / `FASTRTPS_DEFAULT_PROFILES_FILE` (`ZENOH_ROUTER_CONFIG_URI` etc.) into `.env`/`config/` when `RMW_IMPLEMENTATION=rmw_zenoh_cpp`.
- Verification plan: extend the reproduction experiment of [[record_start_two_phase_report]], scale up the airoa sample bag (do not hunt for new OSS bags), and measure the 3 methods Fast DDS / Cyclone DDS / Zenoh side by side (Iceoryx remains out of scope).

**TBD (configuration change, needs user judgment; added 2026-07-09): consolidate kairos's own duplicate subscriptions into one.** Mitigation ② above ("reduce concurrent readers") is an operational workaround that stops some readers only while load is critical. As a permanent fix, changing the design so that recorder / topic_monitor / webrtc_streamer / topic_probe — which currently each subscribe to the same image topics independently — instead have a single process subscribe once and fan the data out in-process for all four purposes would cut kairos's own full-copy count by up to 4x, regardless of whether SHM is in effect (it helps without waiting for Iceoryx support, and is achievable with kairos alone). However, this is a change of a scale that breaks the current "1 folder = 1 container" convention (four independent containers; see [README](../../../README.md)), so it needs user judgment. **ROS 2 composition (`rclcpp_components` / component containers) cannot be used for this** (researched: rclpy has no composition / intra-process comms support at all — see `ros2/rclpy#575`, `#599`. And even if it did, composition only achieves zero-copy when the publisher and subscriber can be placed in the same process — the publisher here, the robot-side camera driver, is an existing process outside kairos's control, so it cannot join in the first place).
**Added 2026-07-10: this TBD has been adjudicated in §5 (the Option C review)** — consolidation is **conditionally adopted (optional) for the 3 non-recorder consumers (monitor/streamer/probe) only**, and **the recorder is structurally outside the consolidation** (it keeps its independent container and independent 1-hop subscription). At the current compressed bandwidth there is empirically no rush (zero loss even with 4 subscribers). Follow the finalized design in §5.3 when uncompression materializes.

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
- The default is `make import-runs` (`deploy/sync/import_runs.sh`): the unit of discovery is
  **`objects/<capture_id>`**, and only those whose `object_manifest.json` carries a `state` of
  **`completed` / `interrupted`** are rsynced from the robot (`--partial --append-verify`,
  bandwidth-limitable with `BWLIMIT`). `digest_state` is deliberately not part of the condition — the
  digest is the **receiving** side's job, so waiting on it would deadlock. It is idempotent and can be
  run on a timer. Each capture is rsynced into `$DATA_DIR/.incoming/<capture_id>` and then, once
  complete, moved into `objects/` with an `os.replace` on the same filesystem (rsync transfers in
  sorted order, so `object_manifest.json` arrives ahead of the huge `*.mcap` — a transfer cut short
  would otherwise leave behind a directory that looks complete while its bag is truncated). That
  preserves the invariant that **the only incomplete directory ever visible under `objects/` is one
  the local recorder is in the middle of writing** ([capture_store](capture_store.md) §2). What
  arrives is picked up and turned into a row by the orchestrator's reconciler, so this script is
  usable even when the orchestrator is not running.
- Do not let the recorder POST files (to avoid coupling upload failures to the recording lifecycle).
- **v2 removed every step that moves files** (`dataset_export` is retired; a dataset is a DB row).
  The only thing that still moves bytes is the per-capture archive, whose destination is validated
  against `KAIROS_ARCHIVE_ROOTS` and rejected when it overlaps `data_dir` (checked in both directions
  by realpath).
- **Save-triggered auto-pull (optional, default OFF)**: the recording-PC stack bundles an **importer
  sidecar** (`deploy/sync/`, defined ONLY in `compose.recording.yaml` — it does not exist in the
  single-host `compose.yaml`, so `make up` is entirely unaffected). With
  `transfer.auto_pull_on_save: true` in the recording config (edited via Settings > Advanced JSON,
  the same way as `recording.pre_arm`), the orchestrator POSTs `/pull {"capture_id": …}` to the
  importer right after a Collect Save (**the first review saved against that capture** =
  `PATCH /api/v1/captures/{id}/review`) and only that capture is rsynced in (same terminal-state
  gate, idempotency and resume guarantees as the manual path). The importer's `/pull` **validates its
  body strictly**: either `{"capture_id": <uuid7>}` or `{"all": true}`, and a body it cannot interpret
  is a `400`. The old behaviour of reading an empty body as "pull everything" was removed — across a
  key rename, a single mix-up would have turned it into a sweep of the whole robot. **Default false =
  nothing is ever transferred without an explicit opt-in.** The robot-side copy is **kept** (a pull
  is a copy, never a move; robot-side retention is a separate **TBD**). Recovery for failed pulls:
  `IMPORT_SWEEP_S` (periodic sweep, default 0 = off) or the manual `make import-runs`.
- **Passwordless auth (shared by all rsync/ssh paths, set via env)**: put `ROBOT_SSH_PASSWORD`
  (via sshpass — write it and go; note it is a plaintext password, trusted-LAN posture) or
  `ROBOT_SSH_KEY` (absolute path to an identity file, preferred) in `.env.split` (see
  `.env.split.example`). `make import-runs` / `make push-config` / the importer sidecar all read
  the same settings.
- **Transfer × recording overlap is measured and harmless** (measured 2026-07-16; the measurement
  harness dated from the v1-layout era and has been removed — the scripts are in git history at
  `deploy/test/overlap_eval/`): even at 30–60× any real link's intensity (loopback 715 MB/s with
  doubled ssh crypto), 0 drops and a worst-topic rate change of −0.1 % (well inside §5's <1 %
  primary criterion). `BWLIMIT` is therefore a lever to protect the **WebRTC preview's share of a
  thin link** (WiFi/Tailscale), not the recording. Re-measure before relying on it on the real HSR
  (the measurement box had NVMe + ample CPU).

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

## 5. Option C (reviewed, conditional): a single boundary bridge — **rejected** as a permanent architecture, only the gated residue is adopted

> 2026-07-10. Origin: the concern that "kairos's containers each subscribing to ROS topics individually is
> inefficient, and if we add multiple validations with dora going forward, communication will collapse."
> We fixed the primary evaluation criterion as
> **"the recorded-topic frequency must not drop due to the influence of surrounding features while a rosbag is being recorded"**
> and reviewed it in a 3-agent debate of an adversarial reviewer / a design advocate / an arbiter (operational viewpoint).
> The quantitative basis is 330+ cells of single-host transport measurements
> (REPORT.md / REVIEW.md of [sige0002/ros2-transport-bench](https://github.com/sige0002/ros2-transport-bench)).
> Only the complete conclusions of the debate are fixed here.

### 5.1 The original proposal (under review)

A robot-side egress `zenoh-bridge-ros2dds` (DDS pinned to loopback, same as Option B) + a host-PC-side ingress
bridge that **re-publishes to a host-only DDS domain (e.g. 42)**; the existing 4 containers
(recorder/monitor/streamer/probe) subscribe to domain-42 unmodified, and new validation is a single
`ros_bridge` → dora dataflow (Arrow+shm) → validator×N. The aim: "always one copy on the physical link,
constant robot pub CPU, the marginal cost of adding a validator is CPU only, no container consolidation."

### 5.2 Record of the debate (summary)

**The core of the critique (the multiplicative survival model, accepted by the advocate too as a governing principle)**:
`recorded_freq = source_publish_rate × Π(per-hop survival rate)`, each survival rate ≤ 1. **A hop can subtract
frequency but never add it.** Option A's recorder is 1 hop from camera→recorder (local SHM); the original proposal
C is 3 hops (① robot egress ② LAN zenoh session ③ domain-42 DDS re-publish), of which ②③ are unmeasured and ②
is TCP congestion and thus not tunable. Therefore **C's transfer contribution is structurally ≤0**, and C is
justified only when there is a separate requirement that A structurally cannot supply (live, cross-host consumption).

| # | Point | Verdict | Reflection |
|---|---|---|---|
| 1 | The LAN zenoh session is a non-tunable rate-limiting point (a hop absent in A) | Holds | A Stage-0 measured gate is mandatory. `--max-frequency` thinning is not an escape hatch for recording (a disguise that lowers the denominator) |
| 2 | The domain-42 re-publish is a second DDS shed point (independent of subscriber count: measured 63–71% shed at 1MB / 73–81% at 10MB) | Holds conditionally | domain-42 is **limited to compressed, light topics** (turn the allow-list into an assertion) + a pinned UDP path + raised rmem. Do not put heavy/uncompressed on it |
| 3 | Instrument contamination: a bag taken through the bridge records "the bridge's output", so source-frequency preservation cannot be verified after the fact from the bag | Holds conditionally | The acceptance-test denominator is the **independent publisher-achieved rate** (driver stats or nominal). **Do not use a co-located best_effort subscriber as the denominator** (it sheds 73% itself → a false PASS of 8Hz/8Hz=100%) |
| 4 | The good benchmark result (Zenoh zero loss) is a measurement of `rmw_zenoh_cpp` (native RMW), and the `zenoh-bridge-ros2dds` (gateway) that C uses is not measured in a single cell | **Holds (decisive)** | Putting the bridge into production on the basis of the REPORT numbers is **forbidden**. Do not conflate them even when troubleshooting |
| 5 | The shared ingress bridge becomes a SPOF for PC-side consumers, and the guarantee class is downgraded from structural (compose-file separation) to configuration-dependent | Holds (limited impact on the primary criterion) | Since the recorder stays on the robot, it does not propagate to recording. Make loopback pinning a **fail-safe assertion** (refuse to start the bridge if it drops) |
| (a) | Is the ingress shim (DDS-42 re-publish) needed as a migration scaffold | Holds conditionally | The RMW constraint and 3 conditions in 5.3 below. **Distinguishing the gateway from the shim** is the core of the verdict |
| (b) | The **shared-writer coupling** of a reliable camera publisher × reliable bridge subscription (a stall downstream of the bridge throttles even the recorder on the robot) | **Holds (the most important remaining risk)** | **Structurally forbid reliable ingress** (refuse to start the bridge if detected). Always subscribe to source topics best_effort, and for consumers that need zero loss, confine it downstream via "a reliable subscription to the bridge's own writer" (the source camera writer is a single real-robot driver and is structurally shared = a "dedicated writer" is impossible at the source). + Make the **source-integrity guard** (that the publisher-achieved rate does not drop when the bridge is added) a NO-GO gate for every Stage |

**Fundamental constraints the debate established (the arbiter filled in blind spots of both debaters)**:
- **native rmw_zenoh cannot consume a DDS publisher** (the same-RMW-both-ends principle). As long as the robot's
  publisher is DDS, the boundary `zenoh-bridge-ros2dds` is not "a shim slated for removal" but a **permanent boundary
  translator**. The only removable shim is **the PC-side DDS-42 re-publish** (it disappears once the PC-side consumers become rmw_zenoh).
- **A best_effort shared writer does not cause inter-reader coupling** (a slow reader only drops its own samples).
  The coupling where siblings starve each other arises only with reliable.
- **On-robot recording is not unconditionally safe in the uncompressed regime either**: at 10MB@30Hz even a
  best_effort local reader sheds ~73% due to SHM ring overwrite (rmem-independent). Zero-loss recording requires
  a source-side knob — the recommendation is a **rmem-tuned UDP path** (measured 0% loss, no tail increase);
  reliable QoS only when p99 100–222ms is acceptable.
- **"Terminus = B native" is reachable only when the source is zenoh**. For a robot with a DDS publisher, the
  terminus is "gateway (best_effort ingress) + a PC-side native rmw_zenoh peer (DDS-42 abolished entirely)"
  (same-RMW-both-ends constraint).
  **⚠ Caveat from Stage-0 measurement (2026-07-10, G4)**: directly connecting a subscriber of rmw_zenoh_cpp 0.2.9
  to a session of zenoh-bridge-ros2dds v1.9.0 yields **zero reception (incompatible)**. With the current version
  pair, this "PC native peer" terminus form cannot be connected directly, and PC-side consumption is for now
  **only possible via a second bridge (ingress re-publish)**. Until bridge↔rmw_zenoh compatibility lands upstream,
  the DDS-42 equivalent is not "a removable shim" but structurally necessary. Re-run the compatibility probe
  (the G4 cell of the harness below) at every version update.
- **Name the infrastructure premise of the live heavy-data path**: the condition for survival=1.0 is
  "link bandwidth > sustained payload". At 300MB/s, 10GbE-class or source-side compression is a hard premise.
  The benchmark's 10MB@30Hz full delivery is a loopback figure; across a real NIC it is unproven until measured in Stage-0.

### 5.3 Overall verdict

**Option C (as a permanent architecture) = rejected. Only the useful residue is adopted with amendments** (in effect
a convergence onto "fix A as the system of record + limit a gated bridge to live consumption only").

> The central fact of the judgment: **with the current compressed real camera data (~5.6MB/s), the recording
> frequency does not drop under any configuration or placement (measured, zero loss for all configurations even
> with 4 subscribers).** What justifies C's complexity is only the assumed point of uncompressed 10MB@30Hz, which
> is a spec value, not a measurement of the current deployment. **There is no basis to build C now.** The trigger
> is "the materialization of uncompressed / large-resolution", and even then the primary solution is A + source-side
> knobs (rmem/QoS). The bridge is introduced only when "a named hard requirement of live PC consumption" arises,
> passing the gates one stage at a time.

**The finalized design (the substance of the amended adoption)**:
1. **The recorder is always on the robot (A placement)**. The only placement that reconciles source
   non-intrusiveness with lossless capture. Recording via a PC-side bridge is not the system of record (treat it
   as secondary even if built)
2. Whether a boundary gateway is needed is determined by "the robot publisher's RMW": DDS → a gateway is
   permanently mandatory / if the robot can be made zenoh, native end-to-end needs no gateway
3. Implement the PC-side DDS-42 shim only when **all 3 conditions** hold: (i) the robot publisher is DDS and
   outside our control (ii) the PC-side consumer to be reused is not ported to rmw_zenoh (iii) **a dated live-PC
   full-data recording requirement that A+rsync cannot satisfy is documented**. Otherwise do not build it
4. The boundary bridge subscribes to heavy/camera topics **pinned to best_effort** + make the source-integrity
   guard a NO-GO gate
5. Loopback pinning is a fail-safe assertion (a net-lo≈0 check; refuse to start the bridge on failure) + domain-42
   is isolated as a dedicated domain
6. The dora validator is **limited to post-hoc, PC-local, finalised runs** (it reads the rsync copy from §3.4).
   Only when live validation becomes a requirement does it pass the gates of the bridge path
7. Keep one best_effort non-intrusive rate monitor resident on the robot (so that monitoring does not go down
   together when the bridge degrades)
8. **Turn the reliable-ingress ban into an assertion**. reliable QoS is always downstream of the bridge only
   (a reliable subscription to the bridge's own writer). A configuration that attaches a reliable reader directly
   to the source camera writer is refused startup
9. Stage-0 measurement is done **across a real LAN (real NIC, real switch)**, for **both** the bridge path and the
   native cross-host path, with the operational payload. Include "link bandwidth > sustained payload" as a GO condition
10. The §2 TBD (consolidating duplicate subscriptions) is **conditionally adopted (optional) for the 3 non-recorder
    consumers (monitor/streamer/probe) only**: reduce the robot's camera subscribers 4→2 to increase the recorder's
    frequency headroom. However, **the recorder is structurally outside the consolidation** (it stays an independent
    container with an independent 1-hop subscription). The coupling of the consolidation node (1 crash stops 3) is
    confined to the restartable preview/monitoring class, so it does not propagate to the primary criterion. The
    point of breaking "1 folder = 1 container" needs user judgment

### 5.4 Acceptance conditions (the measurement formula common to all Stages)

- `R_pub(T)` = the publisher's achieved publish rate. **Its source is fixed to driver stats or the nominal
  configured rate** (do not use a co-located best_effort subscriber as the denominator — to avoid a false PASS)
- `F(T)` = recorded message count / (R_pub × window length)
- Primary condition: **F(T) ≥ 0.99 sustained for 10+ minutes** on every recorded topic, under each of the load
  conditions {recorder alone / +monitor / +streamer (real re-encode) / +probe (real decode) / +dora validator (post-hoc concurrent) / all concurrent}
- Coupling condition (the very concern of this matter): **F(all concurrent) ≥ 0.99 × F(recorder alone)**
- source-integrity guard: R_pub itself does not drop even when a boundary reader is added. If it drops, that configuration is NO-GO
- Measure with **both compressed ~5.6MB/s and uncompressed 10MB@30Hz**, and state explicitly which one it passed with

### 5.5 Per-Stage go/no-go

- **Stage 0 (lab characterization, no production)**: the measurement harness is implemented as
  [ros2-transport-bench/stage0/](https://github.com/sige0002/ros2-transport-bench/tree/main/stage0)
  (two modes — a netns pseudo-LAN and a 2-host real LAN — with gates G1–G4 as executable cells).
  Preliminary netns measurement (2026-07-10, not valid for a GO decision): the bridge chain passes 300MB/s at
  F=1.000, adheres strictly to one copy at the boundary, a KEEP_LAST writer is not throttled even under a 200Mbit
  limit (R_pub unchanged, though the KEEP_ALL variant is unmeasured), and on the default kernel **even a 1-hop
  recorder on the robot is F=0.168** (proof that the rmem knob is mandatory).
  GO = with the bridge pinned best_effort + **no reliable ingress (assertion)**, the source-integrity guard passes
  / with the real component (zenoh-bridge-ros2dds), **across a real NIC and real switch**, with the real payload,
  F≥0.99 on **both paths** through-bridge and native cross-host (the denominator is the independent R_pub) /
  "link bandwidth > sustained payload" is satisfied / the robot DDS's loopback pinning is verified with byte
  counters / rollback is demonstrated with one command per host.
  NO-GO = the writer is throttled / F<0.99 / DDS leaks outside the boundary → **fall back to A**
- **Stage 1 (preview only through the bridge, recording on the robot)**: GO = under all-concurrent load (including
  the egress bridge running), the robot bag's F≥0.99 / domain-42 is compressed/light only / demonstrate that
  **the robot bag continues at full rate even while the bridge is killed**. When the consolidation node
  (finalized design 10) is introduced, confirm structurally that "the recorder is outside the consolidation".
  NO-GO = the recorder's F drops more than 1% vs. alone while the bridge runs → keep the preview on the existing light path
- **Stage 2 (PC live full-data recording, entered only when a named hard requirement exists)**: if we control the
  robot RMW → a flag-day to native rmw_zenoh (omit the DDS-42 shim). If the robot is DDS → a permanent gateway +
  prefer a rmw_zenoh peer on the PC side, with the shim only under the 3 conditions of 5.3-3. GO = through F≥0.99 +
  the guard passes + **fidelity diff <1% vs. a simultaneously recorded on-robot A bag** (record both and reconcile).
  NO-GO = any failure → do not provide PC live full data, **A remains the system of record**

## 6. Caveats (pitfalls)

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

## 7. Summary

The only structural solution to "not overloading the robot" is **to not let heavy data leave the robot's DDS onto the network**.
The default **Option A (edge recording + placement split)** guarantees this by not placing any DDS reader on the recording-PC side.
Use **Option B (robot-side Zenoh gateway + DDS pinned to localhost)** only when you need live full data from a separate PC.
The single-host configuration (`compose.yaml`) works as before with nothing changed.
**Option C (a single boundary bridge) has been reviewed in a 3-agent adversarial debate (§5)**: rejected as a permanent
architecture. It is settled that "recording is always on the robot (A), and the bridge is used only through gates when a
hard requirement of live PC consumption arises". Because the recording frequency does not drop under any configuration at
the current compressed-data bandwidth (measured), the correct answer is to build nothing now.
