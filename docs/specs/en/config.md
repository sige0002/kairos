<!-- AUTO-GENERATED from docs/specs/ja/config.md. Do not edit by hand — edit the Japanese source and run /sync-docs. -->
# Shared configuration (config) Specification

> Status: design finalized (v1). Japanese is the source of truth (it is authoritative). The English version `docs/specs/en/config.md` is an auto-generated mirror (do not edit it directly). **No authentication.** The network **assumes a trusted local network (LAN)** and permits LAN exposure.

The single source of configuration shared across services, and the rules for externalizing it. The requirement is to be "**easy to control**."

## Three-layer structure

1. **Infrastructure settings (root `.env`)** — interpreted by docker compose and passed to each service via env. Values fixed at startup (ports, domain, paths, etc.).
2. **Deployment tuning (YAML, `RECORDING_CONFIG`)** — recording/monitoring tuning (target topics, expected_hz, QoS overrides, etc.). Loaded with type validation via pydantic.
3. **Runtime settings (`GET /api/v1/config`)** — values that `api_orchestrator` distributes to the frontend (endpoints, tab structure, defaults, schemas). The frontend fetches these before rendering (does not hardcode them). `defaults` also includes `ros_domain_id` (the current ROS 2 domain; for header display). The entire RECORDING_CONFIG can be edited and persisted from the UI (`PUT /api/v1/config/recording`; see below).

## Root `.env` (infrastructure settings)

| Key | Default | Description |
|---|---|---|
| `ROS_DOMAIN_ID` | `0` | The ROS 2 domain shared by all services |
| `ROS_DISTRO` | `jazzy` | The ROS 2 distro of the base image |
| `RMW_IMPLEMENTATION` | `rmw_fastrtps_cpp` | DDS implementation. Both RMWs (Fast DDS and Cyclone DDS) are bundled in the images, so this key switches between them. For a Cyclone DDS robot, set `rmw_cyclonedds_cpp` (see below) |
| `DATA_DIR` | `./data` | Host-side data root (→ container `/data`) |
| `RECORDING_CONFIG` | `config/recording.yaml` | The recording/monitoring YAML config file (see below) |
| `BIND_HOST` | `0.0.0.0` | API bind target. **Permits LAN exposure** (assumes a trusted LAN, no authentication). Do not directly expose to an untrusted network |
| `API_ORCH_PORT` | `8000` | `api_orchestrator` public port |
| `TOPIC_MONITOR_PORT` | `8001` | `topic_monitor` port |
| `WEBRTC_PORT` | `8002` | `webrtc_streamer` signaling / http port |
| `FRONTEND_PORT` | `8080` | frontend serving port (`5173` in dev) |
| `RECORDER_PORT` | `8010` | `rosbag2_recorder` internal port (binds to the host under host networking) |
| `DORA_RUNNER_PORT` | `8020` | `dora_runner` internal port (binds to the host under host networking) |
| `WEBRTC_PUBLIC_URL` | `http://<host>:8002` | The URL the frontend connects to directly for video/signaling (the host IP / name on a LAN) |
| `CORS_ORIGINS` | `http://localhost:8080,http://localhost:5173` | The origins allowed by the orchestrator and `webrtc_streamer` (served + dev; add the relevant host's origin when exposing on a LAN) |
| `LOG_LEVEL` | `INFO` | Log level |
| `RETENTION_DAYS` | `0` | `0`=disabled. With `>0`, old runs become deletion candidates by retention period |
| `MAX_RECORD_BYTES` | `0` | `0`=unlimited. With `>0`, automatically stop recording on exceeding it |
| `ALERT_CONFIG_PATH` | (optional) | `topic_monitor`'s alert definition file |
| `CYCLONEDDS_URI` | (optional) | Cyclone DDS config file URI (e.g. `file:///config/cyclonedds.xml`). Use it to declare unicast peers, etc., when multicast discovery does not work across hosts. Passed to the container via `env_file` (all 3 ROS services mount `/config` read-only) |

- Services communicate within the trusted LAN (the default is host networking with `localhost:<port>`; internal ports are as in the table above). On a multi-tenant host, switch to a bridge network + DDS unicast (see the network notes in `compose.yaml`).
- The common settings schema lives in `libs/` (pydantic-settings is assumed), and each service reads env in a typed manner.

### Switching the DDS implementation (Fast DDS ↔ Cyclone DDS)

In ROS 2, the two ends (the robot and the subscriber) must use the **same RMW implementation** to communicate (cross-vendor interop between Fast DDS and Cyclone DDS is not supported by ROS 2). If the robot publishes over Cyclone DDS, match the Kairos side to Cyclone DDS too.

- The three ROS services (recorder / monitor / streamer) images **bundle both RMWs** (Fast DDS and Cyclone DDS). Set `RMW_IMPLEMENTATION=rmw_cyclonedds_cpp` in `.env` to **switch without rebuilding** (the default is `rmw_fastrtps_cpp`).
- Also make sure **`ROS_DOMAIN_ID` matches the robot** (default `0`).
- No extra setup is needed when multicast discovery works on the same host / same LAN. When discovery does not work across hosts, declare unicast peers via `CYCLONEDDS_URI` (see the table above).
- The local-verification test harness (`deploy/test/`, which plays back a bag to act as the robot) also bundles both RMWs and is switchable via `RMW_IMPLEMENTATION`, so you can verify the Cyclone DDS path with the sample bag.

## Recording/monitoring YAML (`RECORDING_CONFIG`, deployment tuning)

Per-deployment tuning shared by `rosbag2_recorder` and `topic_monitor` (see `../rosbag-view` for reference). Type-validated with a pydantic model, and topics are applied by pattern (fnmatch) match.

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
# monitor / recording / validation reference config/recording.yaml (dataset is stage3)
```

- **`recording` tuning**: in addition to `start_delay_s` (waiting for publisher warmup), as a measure against the subscription-establishment lag at start it has `start_paused` (default `false`; `true` enables `--start-paused` + the subscription readiness gate + resume) and `subscription_ready_timeout_s` (default 5.0). For details see [rosbag2_recorder](rosbag2_recorder.md).
- **Editing/persisting from the UI**: this entire `RECORDING_CONFIG` can be edited from the Config tab (`GET/PUT /api/v1/config/recording`, [api_orchestrator](api_orchestrator.md)). `PUT` is type-validated with `RecordingConfig` (failure is `422`), written atomically to the config file, and the in-memory settings are hot-swapped. `default_topics` / `robot_name` take effect immediately; `expected_hz` / QoS take effect on **restart** of each service.

## Runtime settings (`GET /api/v1/config`)

What `api_orchestrator` returns for the frontend (example):

```json
{
  "endpoints": { "api": "/api/v1", "events": "/api/v1/events", "webrtc": "<WEBRTC_PUBLIC_URL>" },
  "tabs": [
    { "id": "record",    "enabled": true },
    { "id": "monitor",   "enabled": true },
    { "id": "stream",    "enabled": true },
    { "id": "runs",      "enabled": true },
    { "id": "pipelines", "enabled": false }
  ],
  "defaults": { "expected_hz": {}, "encoding": "vp8", "default_topics": [], "robot_name": "...", "ros_domain_id": 0 },
  "schemas": {
    "record_start": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "required": ["topics"],
      "properties": {
        "topics": { "oneOf": [ { "type": "array", "items": { "type": "string" } }, { "const": "all" } ] },
        "compression": { "enum": ["none", "zstd"], "default": "none" },
        "split": { "type": ["object", "null"],
          "properties": { "max_size_mb": { "type": ["integer", "null"] }, "max_duration_s": { "type": ["integer", "null"] } } }
      }
    },
    "pipeline_forms": {
      "fast_validation": {
        "type": "object", "required": ["template"],
        "properties": { "template": { "type": "string" } }
      }
    }
  }
}
```

- **Tabs are registry-driven.** The backend can swap their display, order, and enabled/disabled state (the "easily reconfigurable" requirement).
- `schemas` are **JSON Schema (draft 2020-12)**. The frontend renders forms from these (backend-driven; e.g. `record_start` and each pipeline's execution form; nullable, enum, and defaults are all fixed).

## Common conventions

- **Network assumption**: a trusted LAN. No authentication. LAN exposure is permitted, but do not directly expose to an untrusted network such as the internet.
- Timestamps are **UTC ISO8601** (e.g. `2026-06-24T01:23:45.123Z`).
- The error format is common to all APIs: `{ "error": { "code": "...", "message": "...", "details": {} } }`.
- Each service has `GET /healthz` (liveness) / `GET /readyz` (readiness).
- Logs are JSON lines (include `run_id` / `component` / `request_id`).
- The backend exposes OpenAPI (`/openapi.json`). The frontend auto-generates a client from it (Orval, [frontend](frontend.md)).

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
