---
name: kairos-dora
description: Accumulated dora-rs integration knowledge for kairos — version pins, the 4 carried patches, user architecture rulings, measured performance, and the debugging playbook. Load this before ANY dora-related work in this repo.
---

# kairos × dora-rs — integration knowledge base

Two deliberately different dora surfaces exist in kairos:

- **dora_live** (`services/dora_live/`) — robot-edge live DDS ingest + fan-out,
  replacing the legacy trio (topic_monitor/topic_probe/webrtc_streamer) behind
  byte-compatible HTTP contracts (:8005/:8006/:8007). Opt-in via `LIVE=1`
  (compose profile `live`). Canonical spec: `docs/specs/ja/dora_live.md`.
- **dora_runner** (`services/dora_runner/`) — post-recording validation/
  conversion. dora here is an **execution contract, not a runtime**: pipelines
  run in-process today with the dataflow shape kept dora-compatible.

Deep investigation reports (local, gitignored): `dev_docs/codex_dora_bottleneck.md`
(per-event cost anatomy), `dev_docs/codex_0hz_investigation.md` (SEDP wedge).

## 1. Architecture rulings (user decisions — do NOT relitigate)

- **dora_live lives on the robot edge** (ruled 2026-07-22 evening, commits
  a2e9093 + 63ae0c7). This explicitly OVERRIDES the 07-21 debate verdict
  "no dora on the live DDS path / robot side, permanently" — the later ruling
  wins. Live topics never cross the wire as DDS; only derived data leaves the
  robot (metrics JSON :8005/:8006, encoded WebRTC :8007, HTTP pulls, rsync).
  Note: the 07-21 `kairos_validation_architecture.md` rewrite is an agent
  PROPOSAL, not user-ratified; earlier D1–D8 line decisions live in
  `dev_docs/archive_validation_architecture_20260721.md`.
- **Live scope**: monitoring + results that "settle in the window between
  recordings", nothing more. The operator teleops through that window (robot is
  never idle) — budget conservatively, bursts included. Heavy analysis all goes
  to dora_runner on the recording PC, after rsync.
- **live_ingest = ONE process / ONE DDS participant** with N Rust-side metrics
  subscriptions (ruled topology, commit 0ae742c). Per-topic bridge processes
  remain ONLY for video-lane topics (SHM fan-out to webrtc/frames nodes).
- **frames lane = pull contract** (`GET /live/frames` + `GET /live/frame?topic=`,
  ETag/304). Push was rejected: the robot must never know consumer addresses,
  a stopped consumer costs the robot nothing, nobody pulling = zero wire cost.
- **ai node deleted** (07-22): live image judgment is not done now — only the
  generic event-intake seam remains (`POST /internal/analysis/events` →
  `GET /live/events`). The consumer half (image validator) is designed-for but
  unimplemented (recording-PC side, `report/live_image/`, `coverage: sampled`).
- **Hybrid rclpy/dora per-topic mixing rejected** — user: 「構成はシンプルな方が
  絶対いい」. Pick whole stacks: LIVE=1 all-dora vs LIVE=0 all-legacy. The 07-23
  rclpy-raw ingest replacement proposal was withdrawn once the rustdds bump
  fixed FastDDS interop — all-dora stands.
- **Safety is carried by topology, not QoS**: rosbag2_recorder keeps its own
  independent subscription; total dora_live failure leaves the canonical MCAP
  path intact.
- **Retreat lines, kept alive on purpose**: PyPI wheel once a release ships
  domain support (dora-rs/dora#1626); legacy trio code preserved as the LIVE=0
  fallback — honestly presented as ~3x lighter at low topic counts (§3), so
  CPU-first deployments may legitimately pick LIVE=0.
- **Docs**: specs are markdown with embedded mermaid (user preference, 07-21);
  no HTML-artifact diagrams. No physical dataset split by label (07-13).

## 2. Version / pin state

- `DORA_COMMIT` default `de261f7773f7bdaa7e7044ec43122f1b0e821731`
  (compose.yaml arg → `services/dora_live/Dockerfile`). Source-pinned build
  because released dora (0.5.0–1.0.0-rc.3) **hardcodes DDS domain 0**; upstream
  main resolves `Ros2Context(domain_id)` arg > `ROS_DOMAIN_ID` env > 0 —
  required for real robots (domain 1) and multi-domain dev. Exit condition:
  return to the PyPI wheel when a release ships domain support (dora-rs/dora#1626).
- **CLI and python wheel MUST be built from the same commit** — mixing breaks
  the internal protocol. The Dockerfile builds both from one checkout
  (cargo `dora-cli` + maturin wheel, Rust 1.88.0, python3.12).
  `/dora_commit.txt` in the image records the commit + applied patch names.
- `ros-<distro>-ffmpeg-image-transport-msgs` is baked into the runtime image so
  `FFMPEGPacket` resolves on any robot without a per-robot msgs overlay; decode
  uses the PyAV wheel (no apt ffmpeg).

### The 4 carried patches (`services/dora_live/*.patch`, applied in this order)

| Patch | What / why | Exit condition |
|---|---|---|
| `dora-metrics.patch` | `Ros2MetricsSubscription`: Rust-side arrival/size/header.stamp extraction, bounded queue, 100 ms Python drain batch + probe tap slot. Enabler for the live_ingest 1-process topology; removes the ~0.55 ms/event Python boundary for feed-only topics. Size = logical Arrow bytes (capacity accessors overcount ~70x) | equivalent ships in a dora release (dora-rs/dora#2801) |
| `dora-rustdds-bump.patch` | rustdds 0.11.4→0.13.1 + ros2-client 0.8.1→0.10.0 (no API break). The pinned 16-month-old RustDDS loses FastDDS SEDP reader announcements under load → permanent all-topic 0 Hz wedge. 0.12.0–0.13.1 (2026-06/07) carry the Atostek interop fixes (SPDP response, QoS matching, NACK_FRAG). Upstream's `=0.11.4` pin exists ONLY for a Windows-only pnet build issue (Atostek/RustDDS#375) — irrelevant on this Linux image | upstream dora moves to rustdds ≥0.13 |
| `dora-empty-struct-fix.patch` | Empty message types (`std_msgs/Empty`) panic the CDR→Arrow deserializer (`StructArray::from(vec![])` rejected by arrow) → poisons the RustDDS cache mutex → participant event loop dies → ALL topics 0 Hz. Surfaced only after the interop bump made matching work | upstream fix lands (dora-rs/dora#2804) |
| `dora-graph-watcher.patch` | `Ros2GraphWatcher` (2026-07-23): graph discovery (topic names/types, endpoint counts, offered publisher QoS) from a bare RustDDS participant's SEDP status events. Replaced the control sidecar's rclpy poller node — CPU parity (6.4% vs 5.8%), threads 10 vs 38. rclpy remains ONLY as loud-warning fallback; `DORA_LIVE_DISCOVERY=rclpy` forces it; `/live/status.discovery_source` shows the active backend | dora ships graph introspection |

## 3. Measured performance (dates = when measured)

- **Exec overhead** (2026-07-16, dora 0.5.0, trivial dataflow, n=7 median):
  `dora run` cold **0.63 s**; `dora up` 0.70 s; `dora start --attach` onto a
  warm daemon 1.14 s (slower than run — spawn dominates, not daemon startup);
  `import dora,pyarrow` 0.03 s; **warm resident dataflow 0.16 ms/round-trip**
  (~3800x below cold). The earlier "daemon startup is heavy" claim was retracted.
- **Per-event boundary** (2026-07-22): pinned dora `Node.next()` costs
  **~0.55 ms/event** (synchronous CDR→Arrow on the calling thread + GIL +
  PyArrow FFI + per-event dict). kairos-side handling is 6 µs/event (~1%) —
  the fix had to be Rust-side batching. The pinned API has no raw receive, no
  merged-stream drain, no multi-subscription topic attribution.
- **Generation table** (29 topics / ~970 msg/s synthetic, same host): central
  metrics/probe consumer nodes 118–136% CPU / 2833 PIDS / 3.9 GB → per-topic
  self-reporting bridges 130.7% / 2726 / 3.9 GB → **live_ingest 30% / 495 PIDS
  / 0.65 GB** (~4.5x better; also under legacy monitor's 72% at that load).
  The true bottleneck was the per-topic process fleet's fixed floor (RustDDS
  participant + tokio + zenoh threads per bridge), NOT per-message work — this
  took 4 revisions to establish; don't re-derive it.
- **Legacy trio comparison** (7 topics, docker stats): LIVE=0 ≈15–18% / 35 PIDS
  vs LIVE=1 ≈41% / 818 PIDS (pre-live_ingest); `DORA_LIVE_CPUS=4` → 36.5% /
  477. Real-machine A/B at 29 topics (pre-live_ingest): legacy 155% vs
  dora_live 474%; one field machine hit 454% / 6043 PIDS.
- **`DORA_LIVE_CPUS`** (opt-in): each bridge's tokio worker count scales with
  visible cores (`num_cpus` reads sched_affinity; a cgroup `cpus:` quota does
  NOT shrink it). The entrypoint pins affinity to the first N cores. Guidance:
  8–16 on a 64-core field machine (29 bridges → 6000+ threads unpinned).
- **QoS depth floor** (07-22): a depth-1 auto-matched subscription undercounts
  bursty publishers (legacy monitor 26.8 Hz → 50.0 Hz true after the fix;
  rclpy monitor showed /hsrb/joint_states at 27 Hz vs true 49.2 Hz). Rule:
  min over publishers, then `max(min, default_depth)`; dora_live uses depth 30.
- **Discovery**: cross-RMW SPDP matching takes 6–8 s; dora_live uses a 15 s
  settle window before declaring topics missing.
- **0 Hz wedge repro→fix** (07-22→23): realman 58 topics / 6.4k msg/s / 8 raw
  image ≈108 MB/s reliably reproduced partial match (8/58) then a 3 h total
  wedge; with all 3 patches: 43/43 bridged topics healthy for 5 min (41–43/46
  positive, 0 panics, 17 Empty msgs received); remaining zeros fully explained
  (3 publisher-absent + 2 sparse).

## 4. Debugging playbook / traps

1. **dora ignores `path:` for `.py` nodes** — it runs them with the system
   python, ignoring the venv (a venv interpreter written in `path:` is ALSO
   ignored). Always launch nodes via a plain-executable wrapper:
   `services/dora_live/run_node.sh` (`exec /opt/venv/bin/python -m $DORA_NODE_MODULE`).
2. **`dora run` writes next to the dataflow yml** — a yml on a read-only mount
   dies with `Read-only file system`. Copy it somewhere writable first.
3. **`dora run` puts every node in its OWN pgid** — `killpg` leaves orphaned
   nodes → EADDRINUSE crash loop on restart. Sweep by session ID via /proc
   (`_kill_session` in the supervisor); verified: 11 orphans swept, 0 EADDRINUSE.
4. **Participant-index exhaustion (Cyclone)**: each video bridge is its own DDS
   participant; at 29 bridges, later CycloneDDS nodes fail with
   `RCLError: error creating node` (real cause "Failed to find a free
   participant index" is hidden). Mitigations: `config/cyclonedds.xml` with
   `MaxAutoParticipantIndex=119` (wired via `CYCLONEDDS_URI` by default; A/B
   25/25 vs 22/25), shrink the live set via LIVE_CONFIG `topics`/`exclude`.
   live_ingest removed the metrics-lane fleet structurally. Unrelated
   containers on the same domain also consume the index space.
5. **RustDDS 0.11.4 SEDP wedge signature** (unpatched builds): FastDDS
   publisher reports `Subscription count: 0` while the ingest participant is
   alive; restarting the publisher recovers. Buffer pressure amplifies but is
   not the cause. Fixed by `dora-rustdds-bump.patch`.
6. **Empty-struct panic cascade**: one `std_msgs/Empty` (e.g. `/rosbag/stop`)
   → Arrow panic → poisoned DdsCache mutex → participant event loop dead →
   ALL topics 0 Hz. One bad message type kills the whole participant. Fixed by
   `dora-empty-struct-fix.patch`.
6b. **Cyclone publisher residual (rustdds 0.13.1, measured 2026-07-23)**:
   against a CycloneDDS publisher, discovery + initial data are clean, but a
   few readers (4/43 after minutes, ~2000 msgs each first) lose their SEDP
   match (`Subscription count: 0`) — stable degradation, no cascade. FastDDS
   publishers are clean. Keep FastDDS as the recording/replay default RMW;
   upstream RustDDS↔Cyclone issue.
7. **UDP receive buffer**: kernel default rmem is 212992 B (~208 KB) and
   RustDDS never calls `set_recv_buffer_size` (+45k RcvbufErrors in 12 s at
   43-topic startup, measured). For high-rate/raw-image loads harden the HOST:
   `sysctl -w net.core.rmem_default=16777216 net.core.rmem_max=16777216`
   (container-local sysctl is not isolated under `network_mode: host`).
8. **`RUST_LOG` injection needs a recreate, not `make restart`** — restart does
   not reload env_file values.
9. **Pass `ROBOT` on the make command line** — `.env` beats shell env via
   `_prefer_env`, so an exported `ROBOT=realman` silently loses to a stale
   `.env`. Site-specific robot configs belong under `config/local/<robot>/`.
10. **Bare `docker compose` + stale `.env`**: pass
    `RECORDING_CONFIG=/config/<robot>/recording/default.yaml` explicitly
    (make resolves it for you).
11. **`queue_size` is mandatory on every inter-node input** — the dataflow
    generator refuses omissions and a unit test lints it (dora's default queue
    drops high-rate small messages, bench-proven). Per-lane depths:
    probe 4 / webrtc 2 / frames 2 — preview lanes must be SHALLOW (a deep queue
    means stale frames = seconds of latency + SHM pinning; real incident).
12. **Decode gating**: decode at consumed-fps, not arrival rate (28.6 Hz →
    14.7 fps measured), but the **ffmpeg lane must be EXCLUDED from any
    frame-dropping gate** — inter-frame codecs need every AU; dropping before
    decode breaks H.264 lanes.
13. **Custom types are lazy-resolved** from AMENT_PREFIX_PATH `.msg` files
    (overlay mounted at `/opt/msgs_overlay`); failure arrives as a
    RuntimeError event VALUE — the bridge guards it, and unbridged topics keep
    Hz counting (no size/stamp). Wrong ROS domain shows as "allowlist 0/N
    visible" + pending + readyz 503; crash-loop guard degrades after 3 abnormal
    `dora run` exits in 120 s. The stack never fakes health.
14. **Replay semantics**: `stamp_delay_ms` is wall-clock truth — during bag
    replay it equals the recording's age (hundreds of days). Correct, not a
    bug; don't alarm on it. `dds_samples_lost` is always 0 under RustDDS (no
    RMW events); the loss floor is expected_hz shortfall.

## 5. Extension seams (how users plug in — never modify dora_live)

- **Live frames (images)**: `GET :8005/live/frames` (per-topic index: topic/
  codec/encoding/size/stamp_ns/recv_t/seq) + `GET :8005/live/frame?topic=`
  (latest payload, single latest-wins slot, ETag=seq, `If-None-Match` → 304).
  The robot forwards compressed payloads only: `image` = JPEG/PNG as-is,
  `ffmpeg` = keyframes only, `raw` = excluded (re-encoding on the robot is a
  budget violation). Rate cap: `frames.sample_hz` (default 2.0) in
  `config/<robot>/live/default.yaml`. Template: `docs/examples/grayscale/`.
- **Live events (verdict intake)**: `POST :8005/internal/analysis/events` —
  freeform JSON body; only `t` (epoch seconds) matters to the server (drives
  the `GET /live/events?since=` filter; auto-stamped on arrival if omitted).
  Ring is in-memory, 500 entries, wiped on restart — durable verdicts belong
  in post-recording dora_runner. Template: `docs/examples/range_check/`
  (built from docs alone by an adversarial agent — the contract is self-sufficient).
- **Example pattern** (both): own `dataflow.yml` + node `.py` + `run_node.sh`,
  run under their OWN `dora run` inside the kairos-dora-live image
  (`docker run --network host … /opt/venv/bin/dora run dataflow.yml`) —
  entirely outside the supervisor-managed dataflow.
- **Post-recording validators**: `services/dora_runner` plugin_loader — plugin
  folder with manifest + dataflow.yml + dual-mode nodes (`process(inputs, ctx)`
  in-process / `main()` under dora); in-process interpreter fallback; results
  to `/data/report/<pipeline>/<run_id>/summary.json`, rendered by the generic
  frontend SummaryResult (plugin authors never touch the frontend — spec'd
  contract). Copy-me template: `services/dora_runner/plugins/hello_kairos/`.
  In-tree plugins are baked into the image (`make rebuild dora_runner`);
  USER extensions drop into repo-root `extensions/<name>/` (gitignored,
  submodule-friendly, mounted at /extensions, `KAIROS_EXTENSIONS_DIR`) and
  need only `make restart dora_runner`. `_`-prefixed dirs are never loaded
  (extensions/_template is the copy-me covering BOTH lanes: runner plugin +
  live frames/events sidecar via `make ext-live EXT=<name>`).

## 6. Maintaining the carried patches

- Applied in the Dockerfile builder stage onto the pinned clone:
  `git apply` metrics → rustdds-bump → empty-struct → graph-watcher. **Order matters** —
  Cargo.lock hunks chain across patches (and metrics + graph-watcher both
  touch `python/src/lib.rs`); a patch regenerated out of order fails with
  `error: patch failed: Cargo.lock:…`.
- **Regeneration procedure** (proven flow): fresh clone of dora-rs/dora at
  `DORA_COMMIT` (e.g. /tmp/dora) → `git apply` all PRIOR patches in order →
  make the change → regenerate the diff restricted to the files you touched
  (`git diff -- <paths>`) → overwrite the patch file → verify from pristine:
  `git checkout -- . && git clean -fd`, then `git apply --check` each patch in
  sequence.
- **Compile gate before any image rebuild**:
  `cargo check -p dora-ros2-bridge-python` inside a container that has cargo
  (the ROS Jazzy build env with rustup 1.88, or a rust:1.88 container) — the
  full image build is far too slow as a feedback loop. The host has no cargo;
  a bare host `cargo check` can "pass" vacuously (command-not-found masked by
  a trailing echo) — check the output, not just the exit code.
- When a patch changes: update the carried-patch table in
  `docs/specs/ja/dora_live.md` (EN mirror by hand), the Dockerfile comment
  block, and the `/dora_commit.txt` patch-name lines.
- Each patch has an upstream exit condition (§2) — check dora-rs/dora#1626,
  #2801, #2804 and the rustdds version in upstream's lockfile before extending
  a patch; prefer pushing upstream over growing kairos-only divergence.
