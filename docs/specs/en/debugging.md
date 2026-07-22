# API exploration and debugging guide

A practical guide to "which API lives where, how to peek at it, and what to
check in which order when something doesn't work". Design details live in the
per-service specs (this directory). Run every command from the repo root.

## 1. Port map — what lives where

Every service runs with `network_mode: host`, so a port is a host port.

| Port | Service | What's there | Notes |
|---|---|---|---|
| 8080 | frontend | Web UI; proxies `/api/`→orchestrator plus `/webrtc/` and `/probe/` | the browser only ever needs this |
| 8000 | api_orchestrator | **the single public API** (`/api/v1/*`) + SSE (`/api/v1/events`) | the UI talks only to this; direct ports below are for debugging |
| 8001 / **8005** | topic_monitor / **dora_live** (`LIVE=1`) | `/topics` `/metrics` `/alerts` `/incidents` (compatible); 8005 adds the `/live/*` extension surface | `make ps` shows which one is alive |
| 8003 / **8006** | topic_probe / dora_live probe-compat | `/fields` `/sample` `/stream` (numeric fields) | |
| 8002 / **8007** | webrtc_streamer / dora_live webrtc-compat | `/stream/start·stop·status·offer` | |
| 8010 | rosbag2_recorder | `/record/start·stop·status` | the recording itself |
| 8020 | dora_runner | `/pipelines` (+`plugin_errors`), `/jobs` | post-recording validation/conversion |
| 8030 | importer | split auto-pull sidecar | recording profile only |

## 2. Exploring an API — start with Swagger UI

**Every FastAPI service serves `/docs` (Swagger UI) and `/openapi.json`.**
Open it in a browser for the endpoint list, schemas, and in-place execution:

```
http://localhost:8000/docs   # orchestrator (the public API overview lives here)
http://localhost:8005/docs   # dora_live (under LIVE=1)
http://localhost:8020/docs   # dora_runner
```

On the command line, `curl` + `python3 -m json.tool` is the base pattern:

```bash
curl -s localhost:8000/api/v1/runs | python3 -m json.tool          # run list
curl -s localhost:8000/api/v1/runs/<run_id> | python3 -m json.tool # detail (incl. quick_check)
curl -s localhost:8000/api/v1/topics | python3 -m json.tool        # discovery
curl -s localhost:8005/metrics | python3 -m json.tool              # raw metrics (direct)
curl -s localhost:8020/pipelines | python3 -m json.tool            # pipelines + plugin_errors
```

SSE (continuous streams) with `-N`:

```bash
curl -N localhost:8000/api/v1/events          # unified events (record_status/alert)
curl -N localhost:8005/metrics/stream         # metrics snapshots
```

Submitting a job (what the Validation tab does):

```bash
curl -s -X POST localhost:8020/jobs -H 'content-type: application/json' \
  -d '{"pipeline":"fast_validation","run_id":"<run_id>","params":{"template":"airoa_hsr"}}'
```

## 3. Reading health — healthz and readyz differ

- `GET /healthz` = is the process alive (liveness).
- `GET /readyz` = **can it do its job**. The orchestrator's readyz returns
  `components: {recorder, monitor, streamer}` so you see **which one** is the
  cause. dora_live's readyz folds in dataflow liveness (a dead `dora run` = 503).

```bash
curl -s localhost:8000/readyz | python3 -m json.tool   # names the degraded component
```

## 4. Reading logs

```bash
make logs orchestrator        # follow (service names are positional)
make logs dora_live           # dora node stderr appears with a "node-name:" prefix
make ps                       # container states (extension sidecars kairos-ext-* included)
```

- Logs are structured JSON (the `logger` name tells you where inside a service).
- Raising Rust logs inside dora_live (`RUST_LOG=...`) does **not** apply on
  `make restart` — env changes need a recreate (`make up-nobuild LIVE=1` etc.).

## 5. Symptom playbook

### "Nothing works" — the first move is always smoke

```bash
bash deploy/test/smoke.sh     # health → config → discovery → metrics, PASS/FAIL
```

### No Hz in Monitor

1. `make table` (the replay harness topic table) — see what's on the DDS graph
   **without kairos**.
2. Flowing but not shown → `ROS_DOMAIN_ID` mismatch or `ROBOT` mismatch
   (pass `ROBOT` as a **make command-line arg**; `.env` beats shell env vars).
3. Under `LIVE=1`, `curl -s localhost:8005/live/status`:
   - `dataflow_alive: false` → `make logs dora_live` for node crashes
   - `pending: [...]` → those types are missing from AMENT (custom-msg overlay
     not built)
   - `discovery_source` → `dora_graph` is normal (`rclpy` = fallback, investigate)

### Video absent or slow (the fps chain)

Effective fps is the **minimum** of the chain:

```
source rate (camera driver, or the bag's recorded rate)
  → max_fps cap (LIVE_CONFIG video_defaults / client request)
    → consumption pacing (how fast the viewer actually receives)
```

1. **Source**: check the topic's Hz in Monitor. You can never exceed it
   (bag replays are bounded by the recorded rate; kairos has no setting that
   raises a source).
2. **Delivery**: `curl -s localhost:8007/stream/status` — `state: live` and
   `fps`. That `fps` is a **consumption-following value**: it reads low when
   the connected client is dead (it is not a capability metric).
3. **Black video**: suspect browser-side ICE (network path). Candidate
   resolution failures show in `make logs dora_live` webrtc lines. Black over
   Tailscale is the known MTU case (`WEBRTC_PACKET_MAX`).

### An extension (extensions/) doesn't work

- **Live lane**: `make ps` for the `kairos-ext-<name>` state → if down,
  `make ext-live EXT=<name>` shows the full error. Events missing from the UI:
  `curl -s localhost:8005/live/events` splits "not arriving" from "not shown".
- **Validation lane**: `plugin_errors` in
  `curl -s localhost:8020/pipelines | python3 -m json.tool` (load-failure
  reasons) + `make logs dora_runner` for `plugin load failed`.

### Recording looks wrong

```bash
curl -s localhost:8010/record/status | python3 -m json.tool   # raw recorder state
curl -s localhost:8000/api/v1/runs/<run_id> | python3 -m json.tool
```

The run detail's `quick_check.verdict.reasons` states in plain language why a
run is needs_review. `integrity: dropped/failed` = recorder cache overflow
(`max_cache_size_mb`).

### Load is high

```bash
make load          # CPU (%/core and %/machine) + LAN + DDS bandwidth + disk
docker stats       # per-container (extensions separate as kairos-ext-*)
```

## 6. Where the data lives (inspect the disk directly)

| Path | Contents |
|---|---|
| `data/recorded/<run_id>/` | recorded MCAP (canonical) + metadata.yaml |
| `data/report/<pipeline>/<run_id>/summary.json` | validation results (`result: pass\|fail`) |
| `data/<operator>/<task>/<NNN>/` | exported datasets |
