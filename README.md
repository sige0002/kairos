<!-- AUTO-GENERATED from README.ja.md. Do not edit by hand — edit the Japanese source and run /sync-docs. -->

# kairos

**日本語版: [README.ja.md](README.ja.md)**

A system for **recording, monitoring, validating, and converting** robot data from ROS 2. The
canonical recording format is **MCAP**; live video, live metrics, and post-hoc validation are all
built around that single source of truth.

> **Status:** all 6 services + the frontend are implemented (Stage 1–4). The architecture below is
> based on the diagrams in `fig_const/`.

## Architecture

```
                ROS 2 Robot / Sim  ──►  ROS 2 Topics
                                          │
        ┌──────────────┬──────────────────┼──────────────────────────┐
        ▼              ▼                   ▼                          ▼
  webrtc_streamer  topic_monitor    rosbag2_recorder            (selected topics)
   (live video)    (live monitor)   ──► MCAP  /data/recorded/run_xxxx.mcap  ◄── source of truth
        │              │                   │
        ▼              ▼                   ▼  (after recording)
     Browser  ◄──  api_orchestrator  ──►  dora_runner ──► reports / converted datasets
                  (job & state hub)        (validate / convert pipeline)
                         ▲
                         │ REST / WebSocket / SSE
                      frontend (Vite + React + TS)
```

## Services

| Service | Role |
|---|---|
| [rosbag2_recorder](docs/specs/en/rosbag2_recorder.md) | Records selected ROS 2 topics to **MCAP**. The single source of truth. |
| [topic_monitor](docs/specs/en/topic_monitor.md) | Lightweight, non-destructive live health metrics (Hz / late / gap / loss / bandwidth). Does **not** decode payloads. |
| [webrtc_streamer](docs/specs/en/webrtc_streamer.md) | Low-latency camera **preview** (ROS 2 image → browser). Not a recording path. |
| [api_orchestrator](docs/specs/en/api_orchestrator.md) | The single API hub: job lifecycle, state, settings, and result aggregation. |
| [dora_runner](docs/specs/en/dora_runner.md) | Post-record **validation / conversion** pipeline (dora-based). |
| [frontend](docs/specs/en/frontend.md) | Backend-driven web UI: record control, live video, topic health, run/validation/dataset views. |

## Specification docs

See [docs/specs/en/](docs/specs/en/README.md) for the detailed per-service specs — the **canonical
design** based on the `fig_const/` diagrams (unspecified items fixed as recommended designs; no
authentication).

## Getting started

### Requirements

- **Docker** / **Docker Compose** (to bring up all services together).
- Place a sample rosbag (**MCAP**) under `data/` for local verification (e.g. `data/airoa-moma-mcap/<episode>/`). `data/` and `*.mcap` are gitignored (not committed).
- Only if you run the unit tests directly: **uv** (Python) and **Node.js + npm** (frontend).

### Bring up all services (Docker)

```bash
make up                       # = build + start (detached). RECORDING_CONFIG defaults to /config/airoa_hsr.yaml
# or with plain docker compose:
cp .env.example .env          # edit as needed
docker compose build
docker compose up
```

All services run with host networking. The ROS 2 services (`recorder` / `monitor` / `streamer`)
share the host's DDS graph (`ROS_DOMAIN_ID=0`); the pure-Python services (`orchestrator` /
`dora_runner`) and the frontend reach each other at `localhost:<port>` (no auth; LAN assumed).

### Make shortcuts

To avoid retyping long commands, a `Makefile` at the repo root wraps the common workflows. Run
`make` for the full target list. Service names are **positional** (one or more), and
`RECORDING_CONFIG` is exported by `make` with a `/config/airoa_hsr.yaml` default (avoiding the stale
path in `.env`).

| Command | What it does |
|---|---|
| `make up` / `make down` / `make ps` | start the stack (incl. build) / stop+remove / status |
| `make build monitor` / `make build` | build a service (positional one / no-arg or `all` = every service) |
| `make rebuild frontend` | build + force-recreate (apply code changes) |
| `make restart monitor orchestrator` | restart service(s) |
| `make logs streamer` | follow logs |
| `make config-reload` / `make config-show` | apply `config/*.yaml` edits (restart monitor+orchestrator) / print live config |
| `make rosbag` / `make rosbag-loop` / `make table` | replay sample bag once / on a loop / live Hz table for every topic |
| `make smoke` / `make smoke-record` | end-to-end check (PASS/FAIL) / incl. record start/stop |
| `make test` / `make test-py` / `make test-fe` / `make lint` / `make fmt` | tests, lint, format |

For a different robot use `make up RECORDING_CONFIG=/config/myrobot.yaml`; for a different bag,
`make rosbag BAG=/data/airoa-moma-mcap/000730`.

### Main endpoints (default ports)

| Service | Port | Examples |
|---|---|---|
| api_orchestrator | 8000 | `GET /api/v1/config` / `POST /api/v1/record/start` / `GET /api/v1/events` (SSE) / `POST /api/v1/jobs` |
| topic_monitor | 8001 | `GET /metrics` / `GET /topics` / `GET /metrics/stream` (SSE) |
| webrtc_streamer | 8002 | `POST /stream/start` / `POST /stream/offer` |
| rosbag2_recorder | 8010 | `POST /record/start` / `POST /record/stop` / `GET /record/status` |
| dora_runner | 8020 | `POST /jobs` / `GET /jobs/{id}/result` / `POST /validation/templates/generate` |

The frontend is served by nginx (default `8080`). On load the UI fetches `GET /api/v1/config` and
renders its tabs and schemas backend-driven.

### Typical workflow

1. **Make topics flow**: connect a real robot/simulator, or replay a sample bag.
   ```bash
   # "see" what is flowing (periodic table of every topic's Hz/bandwidth/count)
   docker compose -f deploy/test/compose.yaml run --rm topic_table
   # replay a sample bag onto the ROS 2 graph (separate terminal; single-shot)
   docker compose -f deploy/test/compose.yaml run --rm rosbag_player
   # replay on a loop (keep streaming continuously)
   LOOP=--loop docker compose -f deploy/test/compose.yaml run --rm rosbag_player
   # pick a different bag
   BAG=/data/airoa-moma-mcap/000730 docker compose -f deploy/test/compose.yaml run --rm rosbag_player
   ```
2. **Record**: start via the UI or `POST /api/v1/record/start {"topics":"all"}` → MCAP is
   created under `/data/recorded/<run_id>/` (stop with `POST /api/v1/record/stop`). Filling in the
   Record tab's **Operator / Task** fields saves them — plus topics, message count, and start/end — to
   `/data/recorded/<run_id>/session.json` (beside the MCAP), and they also show in the Runs tab.
3. **Monitor / preview**: `GET /metrics` for live health (Hz / late / gap / bandwidth), `/stream` for
   the camera WebRTC preview. The UI Monitor tab **always lists every topic on the graph** and overlays
   live Hz on the monitored ones. To get Hz for the sample bag, point at
   `RECORDING_CONFIG=config/airoa_hsr.yaml` (which topics to record/monitor is defined in
   [`config/`](config/README.md); it is reflected in the Record tab as a pre-selection).
4. **Post-record validation**: `POST /api/v1/jobs {"pipeline":"fast_validation","run_id":...,"params":{...}}`
   checks for missing/extra required topics → writes `pass`/`fail` to
   `/data/report/fast_validation/<run_id>/summary.json`.

### Test / integration test

- **Unit tests**: `make test` (= Python per service `uv run --extra test pytest` + frontend `npm run build && npm test && npm run lint`).
- **Smoke test (prints PASS/FAIL)**: once the stack is up, `make smoke` (= `bash deploy/test/smoke.sh`).
  It checks health → `GET /api/v1/config` `default_topics` → topic discovery → the monitor's live metrics,
  in order, and prints the result (`make smoke-record` also runs record start/stop). The entry point for
  fixing "I tested it but nothing comes out."
- **Replay with visualization**: `make table` (periodic Hz/bandwidth table for every topic) and `make rosbag` / `make rosbag-loop` (replay).

For detailed commands and verified recipes, see "Build / test / run commands" in [CLAUDE.ja.md](CLAUDE.ja.md).

## Documentation language rule

**Japanese is the source of truth.** Edit the Japanese files (`*.ja.md`); the English files (`*.md`)
are regenerated with the `/sync-docs` skill. Do not edit the English files by hand.

## Contributing

- Code, comments, and commit messages are in English.
- See [CLAUDE.ja.md](CLAUDE.ja.md) for the working agreement and conventions.
