<!-- AUTO-GENERATED from docs/specs/ja/config.md. Do not edit by hand — edit the Japanese source and run /sync-docs. -->
# Shared configuration (config) Specification

> Status: design finalized (v1). Japanese is the source of truth (it is authoritative). The English version `docs/specs/en/config.md` is an auto-generated mirror (do not edit it directly). **No authentication.** The network **assumes a trusted local network (LAN)** and permits LAN exposure.

The single source of configuration shared across services, and the rules for externalizing it. The requirement is to be "**easy to control**."

## Three-layer structure

1. **Infrastructure settings (root `.env`)** — interpreted by docker compose and passed to each service via env. Values fixed at startup (ports, domain, paths, etc.).
2. **Deployment tuning (YAML, `RECORDING_CONFIG`)** — recording/monitoring tuning (target topics, expected_hz, QoS overrides, etc.). Loaded with type validation via pydantic.
3. **Runtime settings (`GET /api/v1/config`)** — values that `api_orchestrator` distributes to the frontend (endpoints, tab structure, defaults, schemas). The frontend fetches these before rendering (does not hardcode them). `defaults` also includes `ros_domain_id` (the current ROS 2 domain; for header display). The entire RECORDING_CONFIG can be edited and persisted from the UI (`PUT /api/v1/config/recording`; see below).

## Root `.env` (infrastructure settings)

> **Which file do I edit? (for first-time users)** All settings are consolidated into a single `.env`. There are
> two templates for different use cases; **copy one of them to `.env`** and use that (do not edit the template
> itself; `.env` is not committed to Git).
>
> - **`.env.example`** — the normal single-PC setup where everything runs on one machine. `cp .env.example .env`;
>   it runs as-is in most cases. Change `ROBOT=` only when using a different robot.
> - **`.env.split.example`** — the split setup that records from a separate "recording PC" instead of the robot
>   ([deployment_topology](deployment_topology.md)). On the recording PC, `cp .env.split.example .env` and just set
>   `ROBOT_IP` to the robot's IP.
>
> When in doubt, use `.env.example`. For a step-by-step walkthrough, see the [README](../../../README.md)
> ("Which `.env` file do I use?"). **The table below is the full key reference** — day to day, you rarely touch most of it.

| Key | Default | Description |
|---|---|---|
| `ROS_DOMAIN_ID` | `0` | The ROS 2 domain shared by all services |
| `ROS_DISTRO` | `jazzy` | The ROS 2 distro of the base image. The `.env` value beats the Makefile's built-in default (`make` reads `.env` and exports it) |
| `RMW_IMPLEMENTATION` | `rmw_fastrtps_cpp` | DDS implementation. Both RMWs (Fast DDS and Cyclone DDS) are bundled in the images, so this key switches between them. For a Cyclone DDS robot, set `rmw_cyclonedds_cpp` (see below) |
| `DATA_DIR` | `./data` | Host-side data root (→ container `/data`) |
| `ROBOT` | `airoa_hsr` | The active robot. Selects `config/<robot>/` (committed) or `config/local/<robot>/` (gitignored); the recording / stream / validation / validators / monitoring paths are derived from it (the Makefile resolves committed/local, and `docker compose` honors it via nested interpolation; additionally each service re-resolves a given committed-shaped path to the `config/local/` side **at startup** when the former does not exist — `kairos_common.resolve_config_path` — so a local robot resolves even under plain `docker compose`). The Settings tab lets you select / edit robot → aspect → option |
| `RECORDING_CONFIG` | `/config/<robot>/recording/default.yaml` | The recording/monitoring YAML (normally derived from `ROBOT`; setting it directly in `.env` overrides the derived path). The path via compose is **container-absolute** (`./config`→`/config` mount) (see below) |
| `STREAM_CONFIG` | `/config/<robot>/stream/default.yaml` | The initial pane definitions for the Stream tab. Derived from `ROBOT` automatically (container-absolute) |
| `LOSS_REPORT_CONFIG` | `/config/<robot>/validators/loss_report.yaml` | `dora_runner`'s loss_report parameters. Derived from `ROBOT` automatically (container-absolute) |
| `MSGS_OVERLAY_DIR` | `./deploy/msgs_overlay/robot` | The bind-mount source for the custom ROS messages overlay. Must start with `./` (avoids becoming a named volume). Mounted read-only on recorder / monitor / probe. See [`deploy/msgs_overlay/`](../../../deploy/msgs_overlay/README.md) for details |
| `BIND_HOST` | `0.0.0.0` | API bind target. **Permits LAN exposure** (assumes a trusted LAN, no authentication). Do not directly expose to an untrusted network |
| `API_ORCH_PORT` | `8000` | `api_orchestrator` public port |
| `TOPIC_MONITOR_PORT` | `8001` | `topic_monitor` port |
| `WEBRTC_PORT` | `8002` | `webrtc_streamer` signaling / http port |
| `TOPIC_PROBE_PORT` | `8003` | `topic_probe` (the numeric-field plotter) port |
| `FRONTEND_PORT` | `8080` | frontend serving port (`5173` in dev) |
| `RECORDER_PORT` | `8010` | `rosbag2_recorder` internal port (binds to the host under host networking) |
| `DORA_RUNNER_PORT` | `8020` | `dora_runner` internal port (binds to the host under host networking) |
| `UID` / `GID` | host uid/gid | Runs the non-root `api_orchestrator` / `dora_runner` as `user: "${UID:-1000}:${GID:-1000}"` so they can write to the host-owned `./data` / `./config` bind mounts. bash does not export `UID` and has no `GID`, so `make` exports `id -u`/`id -g`. With plain `docker compose` on a host where uid≠1000, run `export UID=$(id -u) GID=$(id -g)` |
| `WEBRTC_PUBLIC_URL` | `/webrtc` | Base URL the frontend uses for camera signaling (`endpoints.webrtc` in `/api/v1/config`). The default is the same-origin relative path `/webrtc`, which the frontend's nginx reverse-proxies to `webrtc_streamer`. This makes it work from any access origin (LAN IP / SSH tunnel / Tailscale) without CORS. Set an absolute URL `http://<host>:8002` only for the legacy mode where the browser connects directly to the streamer (then add that origin to `CORS_ORIGINS`) |
| `CORS_ORIGINS` | `http://localhost:8080,http://localhost:5173` | The origins allowed by the orchestrator and `webrtc_streamer` (served + dev; add the relevant host's origin when exposing on a LAN) |
| `WEBRTC_ICE_SERVERS` | `[]` | STUN/TURN for the camera preview. A JSON array in browser RTCIceServer shape (distributed to both the browser and the streamer as `ice_servers` in `/api/v1/config`). Default `[]` = same-LAN direct (host candidates only). Set it only for NAT / WiFi client-isolation / traversal across the internet. A blank or malformed value safely degrades to "no ICE" (never takes the services down) |
| `WEBRTC_PACKET_MAX` | `1150` | RTP payload cap (bytes). The default `1150` shrinks aiortc's hardcoded 1300 B so media does not fragment over a reduced-MTU tunnel (Tailscale/WireGuard = 1280). Restore `1300` only on a same-LAN (MTU 1500) deployment to cut overhead |
| `WEBRTC_KEEP_IPV6` | (unset) | Set to `1` to disable dropping IPv6 ICE candidates from the answer SDP. By default (unset) v6 candidates are dropped (fragmented IPv6 is black-holed over WireGuard/Tailscale, which would turn the preview black). Set `1` only on a genuinely IPv6-only network |
| `LOG_LEVEL` | `INFO` | Log level |
| `RETENTION_DAYS` | `0` | `0`=disabled. With `>0`, old runs become deletion candidates by retention period |
| `MAX_RECORD_BYTES` | `0` | `0`=unlimited. With `>0`, automatically stop recording on exceeding it |
| `MAX_RECORD_SECONDS` | `600` | The wall-clock cap (seconds) of a single recording. `0`=disabled. A disk-protection backstop for orphan (zombie) recordings — closing the tab does not stop recording, so the visible Stop UI is the primary recovery and this is the safety net when unattended. The auto-stop on reaching the cap is settled as a normal completed via the orchestrator's lazy reconciliation |
| `ALERT_CONFIG_PATH` | (optional, default empty=disabled) | `topic_monitor`'s alert definition file (**container-absolute**; convention is `/config/<robot>/monitoring/alerts.yaml`; a `config/local/<robot>/...` override takes precedence). Empty = alerts disabled. `make` derives it from `ROBOT` automatically; with plain `docker compose` set it by hand |
| `CYCLONEDDS_URI` | (optional) | Cyclone DDS config file URI (e.g. `file:///config/cyclonedds.xml`). Use it to declare unicast peers, etc., when multicast discovery does not work across hosts. Passed to the container via `env_file` (the ROS services mount `/config` read-only) |
| `NO_PROXY` | `localhost,127.0.0.1` | Proxy exemption for in-container HTTP (the same value is handed out as `no_proxy` too). On a host behind a corporate proxy, Docker injects `HTTP(S)_PROXY` into every container; without this, healthchecks and service-to-service LAN calls get sucked into the proxy and fail. On the cross-host split add the robot IP (see `.env.split.example`). The orchestrator's internal httpx client is `trust_env=False` to begin with |
| `KAIROS_DORA_MAX_CONCURRENCY` | `2` | The cap on the number of jobs `dora_runner` runs concurrently |
| `KAIROS_DORA_JOB_TIMEOUT_S` | `900` | The wall-clock cap (seconds) per `dora_runner` job |

**`*_HOST` for cross-host split** ([deployment_topology](deployment_topology.md) Option A). Leave at the defaults on a single host:

| Key | Default | Description |
|---|---|---|
| `RECORDER_HOST` / `TOPIC_MONITOR_HOST` / `WEBRTC_HOST` / `TOPIC_PROBE_HOST` / `DORA_RUNNER_HOST` | `localhost` | The downstream service addresses `api_orchestrator` connects to. On the recording PC side, point recorder/monitor/streamer/probe at the robot's LAN IP (dora stays co-located locally) |
| `API_HOST` / `WEBRTC_HOST` / `PROBE_HOST` | `127.0.0.1` | The upstream targets for the frontend's nginx reverse proxy (`default.conf.template`). On the recording PC, point `WEBRTC_HOST` / `PROBE_HOST` at the robot IP |

**For the sample-bag replay harness** (`deploy/test/compose.yaml`, read by `make rosbag` / `make rosbag-loop`; not passed to the 7 core services):

| Key | Default | Description |
|---|---|---|
| `BAG` | `airoa-moma-mcap/235210` | The bag to replay. A path relative to `data/` (e.g. `airoa-moma-mcap/000730`); an absolute path (`/data/...`) also works. Override per-run with `make rosbag BAG=...` |
| `LOOP` | (empty = play once) | Set to `--loop` to replay on a loop (same effect as `make rosbag-loop`) |

- Services communicate within the trusted LAN (the default is host networking with `localhost:<port>`; internal ports are as in the table above). On a multi-tenant host, switch to a bridge network + DDS unicast (see the network notes in `compose.yaml`).
- The common settings schema lives in `libs/kairos_common` (pydantic-settings), and each service reads env in a typed manner.
- compose gives all 7 services a healthcheck based on `GET /healthz` (frontend uses the nginx root), and frontend waits for the orchestrator to become healthy via `depends_on: orchestrator (service_healthy)` before starting.

### Switching the DDS implementation (Fast DDS ↔ Cyclone DDS)

In ROS 2, the two ends (the robot and the subscriber) must use the **same RMW implementation** to communicate (cross-vendor interop between Fast DDS and Cyclone DDS is not supported by ROS 2). If the robot publishes over Cyclone DDS, match the Kairos side to Cyclone DDS too.

- The three ROS services (recorder / monitor / streamer) images **bundle both RMWs** (Fast DDS and Cyclone DDS). Set `RMW_IMPLEMENTATION=rmw_cyclonedds_cpp` in `.env` to **switch without rebuilding** (the default is `rmw_fastrtps_cpp`).
- Also make sure **`ROS_DOMAIN_ID` matches the robot** (default `0`).
- No extra setup is needed when multicast discovery works on the same host / same LAN. When discovery does not work across hosts, declare unicast peers via `CYCLONEDDS_URI` (see the table above).
- The local-verification test harness (`deploy/test/`, which plays back a bag to act as the robot) also bundles both RMWs and is switchable via `RMW_IMPLEMENTATION`, so you can verify the Cyclone DDS path with the sample bag.
- **Same-host shared memory (SHM) is vendor-dependent**: Fast DDS enables it by default with `ipc: host` (already configured). **Cyclone DDS additionally requires Iceoryx (not bundled)**, so even on the same host every reader receives a full loopback-UDP copy. If large messages (images) hit fragment-loss errors, raise the host's `net.core.rmem_max` and enlarge the receive buffer via `<Internal><SocketReceiveBufferSize min="16MB"/></Internal>` in the `CYCLONEDDS_URI` XML. Details and the empirical check procedure: "Conditions for single-host SHM" in [deployment_topology](deployment_topology.md).

## Recording/monitoring YAML (`RECORDING_CONFIG`, deployment tuning)

Per-deployment tuning shared by `rosbag2_recorder` and `topic_monitor`. Type-validated with a pydantic model, and topics are applied by pattern (fnmatch) match.

```yaml
robot_name: hsr
default_topics:            # default targets for recording/monitoring (glob allowed)
  - /tf
  - "/camera/*/image_raw"
expected_hz_patterns:      # pattern → expected Hz (first match wins; omit hz for dynamic learning)
  - { pattern: "/camera/*/image_raw", hz: 30 }
  - { pattern: "/joint_states", hz: 100 }
topic_qos_overrides:       # pattern → QoS (applied by recorder / monitor; first match wins)
  - { pattern: "/camera/*/image_raw", reliability: best_effort, durability: volatile, depth: 1 }
# monitor / recording / validation reference config/<robot>/recording/default.yaml (dataset is stage3)
```

- **`recording` tuning**: in addition to `start_delay_s` (waiting for publisher warmup), as a measure against the subscription-establishment lag at start it has `start_paused` (default `false`; `true` enables `--start-paused` + the subscription readiness gate + resume) and `subscription_ready_timeout_s` (default 5.0). For details see [rosbag2_recorder](rosbag2_recorder.md).
- **Editing/persisting from the UI**: this entire `RECORDING_CONFIG` can be edited from the Settings tab (`GET/PUT /api/v1/config/recording`, [api_orchestrator](api_orchestrator.md)). `PUT` is type-validated with `RecordingConfig` (failure is `422`), written atomically to the config file, and the in-memory settings are hot-swapped. `default_topics` / `robot_name` take effect immediately; `expected_hz` / QoS take effect on **restart** of each service.

## One-click validation presets (`config/<robot>/validation_presets.yaml`)

Defines the Validation tab's "one-click validation buttons" per robot (a flat list at the robot root, not an aspect; committed and gitignored both work). Each preset bundles a dora_runner `pipeline` with fixed `params`.

```yaml
presets:
  - id: hsr_required_topics        # ^[a-z0-9_]+$. stable key for the preset
    name: HSR required topics      # button label
    description: ...               # optional. button subtext
    pipeline: fast_validation      # a dora_runner pipeline id (GET /api/v1/pipelines)
    params: { template: airoa_hsr }# forwarded to POST /jobs verbatim (optional)
  - id: loss_scan
    name: Loss scan
    pipeline: loss_report
```

- `GET /api/v1/validation/presets` ([api_orchestrator](api_orchestrator.md)) returns each preset annotated with the **completed recordings that pipeline has not validated yet** (`pending_run_ids`). Clicking a button runs over all of them (target = not-yet-validated data).
- **"Not yet validated" is keyed per pipeline** (presence of `report/<pipeline>/<run_id>/summary.json`). Presets sharing a pipeline share that state (**one pipeline = one preset recommended**).
- A single broken entry is skipped with a warning (the rest keep working); a missing file means no presets. Add a plugin and just reference its id here to get a button (no UI change). The template is `config/template/validation_presets.yaml`.

## Runtime settings (`GET /api/v1/config`)

What `api_orchestrator` returns for the frontend (example):

```json
{
  "endpoints": { "api": "/api/v1", "events": "/api/v1/events", "webrtc": "<WEBRTC_PUBLIC_URL>" },
  "tabs": [
    { "id": "live",       "enabled": true },
    { "id": "graph",      "enabled": true },
    { "id": "runs",       "enabled": true },
    { "id": "validation", "enabled": true },
    { "id": "dataset",    "enabled": true },
    { "id": "config",     "enabled": true }
  ],
  "defaults": { "expected_hz": {}, "encoding": "vp8", "default_topics": [], "robot_name": "...", "ros_domain_id": 0 },
  "stream": { "columns": 2, "panes": [{ "topic": "/camera/head/color/image_raw/compressed" }] },
  "schemas": {
    "pipeline_forms": {
      "fast_validation": {
        "type": "object", "required": ["template"],
        "properties": { "template": { "type": "string" } }
      }
    }
  }
}
```

- **`tabs` is v1 legacy.** In v1 it was a registry through which the backend swapped display, order and enabled state, but **Console v2's tabs are the 6 fixed in the frontend** (Collect / Review / Datasets / Validation / Monitor / Settings; legacy tab ids redirect — [frontend.md](frontend.md)) and this field no longer drives the display. It remains in the payload for compatibility.
- `stream` is the camera preview's initial layout (`columns` and `panes`, sourced from `STREAM_CONFIG`; Collect's camera panes initialize from it).
- `schemas` are **JSON Schema (draft 2020-12)**. The frontend renders each pipeline's execution form from these (`pipeline_forms` is built dynamically from `dora_runner`'s `/pipelines`; on unreachability it falls back to the static `fast_validation` form). Record-start topic selection is built directly by the Collect / Monitor tabs from discovery and config, and is not part of this schema.

## Common conventions

- **Network assumption**: a trusted LAN. No authentication. LAN exposure is permitted, but do not directly expose to an untrusted network such as the internet.
- Timestamps are **UTC ISO8601** (e.g. `2026-06-24T01:23:45.123Z`).
- The error format is common to all APIs: `{ "error": { "code": "...", "message": "...", "details": {} } }`.
- Each service has `GET /healthz` (liveness) / `GET /readyz` (readiness).
- Logs are JSON lines (include `run_id` / `component` / `request_id`). A shared request-id middleware (`kairos_common`) adopts the incoming `X-Request-ID` (or generates a uuid4 when absent), tags every log line emitted while handling the request with that `request_id`, and echoes it back as the `X-Request-ID` response header (usable for caller-side correlation).
- The backend exposes OpenAPI (`/openapi.json`). The frontend currently uses a **hand-written typed client** (`src/api/client.ts` + `types.ts`); client generation from OpenAPI (Orval etc.) is **not adopted** (a future contract-gate candidate, [frontend](frontend.md)).

## Common API conventions (all HTTP services)

- All types are fixed at a granularity that allows OpenAPI generation (pydantic models). Nullability and defaults are made explicit.
- Status codes: `200` / `201` normal, `400` invalid input, `404` not found, `409` conflict (concurrent start, etc.), `422` validation, `503` internal service unreachable, `507` insufficient capacity. The body follows the error format.
- List APIs use cursor paging: `?limit` (default 50) + `?cursor`, response `{ items: [], next_cursor: string|null }`.
- enums (vocabulary common to all services):
  - run state: `created` | `recording` | `stopping` | `completed` | `failed` | `interrupted`
  - job state: `queued` | `running` | `succeeded` | `failed` | `canceled`
  - encoding: `vp8` | `h264`
  - alert metric: `hz` | `bandwidth` | `gap` | `late` | `loss`
  - alert op: `lt` | `gt` | `le` | `ge`
- Times are UTC ISO8601. Durations and sizes are numeric, with the unit indicated by a suffix (`*_ms` / `*_bytes` / `*_bps`, etc.).

## Operations (data lifecycle)

### Retention period (`RETENTION_DAYS`)

- `RETENTION_DAYS` is **advisory only** — it never auto-deletes (2026-07-14 adjudication). `GET /api/v1/retention` returns the runs it marks as deletion candidates: **not exported** (a run row still exists — export deletes the row), **terminal state** (`completed` / `failed` / `interrupted`; an active recording is never a candidate), and **started more than N days ago** (`{ days, candidates: [{ run_id, started_at, bytes, state, has_episode }], total_bytes }`). Sizes are best-effort directory sums, computed per request. `RETENTION_DAYS<=0` disables it (candidates are always empty).
- Actual deletion goes only through the existing **confirmed** `DELETE /api/v1/runs/{id}` path. When candidates exist the Review screen shows a dismissible banner whose button filters the table down to them (it does not delete). Exported datasets are artifacts and are untouchable.

### Dataset catalog (`data/index.jsonl`)

- A **derived, rebuildable** flat catalog of the exported datasets (one JSON line per dataset). The **sidecars on the tree** (`dataset.json` / `episode.json`) stay canonical; the catalog is only an optimization to avoid walking the tree.
- Appended one line on a successful export, and rewritten without a row on dataset delete (atomic tmp+rename). `dataset_dir` is stored relative to `data_dir` (robust to a moved/restored tree).
- `GET /api/v1/datasets` serves from the catalog when it exists and parses, with **automatic fallback to a tree scan when it is absent or corrupt** (identical response shape). `POST /api/v1/datasets/index/rebuild` regenerates the catalog wholly from the sidecars (returns `{ count }`). `schema_version: 1` (also stamped on `episode.json`; readers default to 1 when absent).

### Backup / restore

- `make backup` writes a consistent snapshot to `backups/<timestamp>.tar.gz`:
  - `data/kairos.db` copied consistently via **`sqlite3 .backup`** (WAL included; if `sqlite3` is unavailable, best-effort copy of the db + `-wal` / `-shm`).
  - `data/index.jsonl` / `data/recorded/` / `data/report/` and the exported datasets (`data/<operator>/<task>/<NNN>/`), plus `config/`.
  - **Not included**: raw sample rosbag inputs (top-level sample dirs under `data/`, named by `BACKUP_SAMPLE_DIRS`, default `airoa-moma-mcap realman` — override to match your sample names), the mp4 preview cache (`data/report/video_check/`), and repo-external secrets such as `.env`. Recordings/reports can change under a live stack, so for a fully consistent snapshot run it while stopped (`make down`).
- **Restore runbook**:
  1. Stop the stack: `make down`.
  2. Extract at the repo root (`<restore_root>`): `tar xzf backups/<timestamp>.tar.gz -C <restore_root>`.
  3. Put the DB snapshot in place: move the extracted `kairos.db` to `data/kairos.db` (overwrite; delete any stale `data/kairos.db-wal` / `-shm`). `config/` and `data/{index.jsonl,recorded,report,<datasets>}` go straight to their paths.
  4. `make up` to restart. Startup reconciliation settles any run left mid-recording to `interrupted`.
  5. If the catalog is suspected to have drifted from the tree, regenerate it with `POST /api/v1/datasets/index/rebuild` (the sidecars are canonical).
