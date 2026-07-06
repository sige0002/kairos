<!-- AUTO-GENERATED from README.ja.md. Do not edit by hand — edit the Japanese source and run /sync-docs. -->
# kairos

**日本語: [README.ja.md](README.ja.md)**

A system that **records, monitors, validates, and converts** ROS 2 robot data. The canonical
recording format is **MCAP**, and live video, live metrics, and post-hoc validation are all
organized around this "source of truth."

> **Status:** All 7 services + frontend implemented (Stage 1–4). The architecture below is based on
> the `fig_const/` diagrams.

## Architecture

```
              ROS 2 Robot / Sim  ──►  ROS 2 Topics
                                        │
     ┌──────────────┬────────────┬──────┼────────────────────────┐
     ▼              ▼            ▼       ▼                        ▼
webrtc_streamer topic_monitor topic_probe rosbag2_recorder  (selected topics)
 (live video)   (live monitoring) (numeric plots) ──► MCAP  /data/recorded/run_xxxx.mcap ◄─ canonical
     │              │            │        │
     ▼              ▼            ▼        ▼  (after recording)
   Browser  ◄────  api_orchestrator  ──►  dora_runner ──► report / converted dataset
                  (job & state hub)        (validation & conversion pipeline)
                         ▲
                         │ REST / WebSocket / SSE
                      frontend (Vite + React + TS)
```

## Service composition

| Service | Role |
|---|---|
| [rosbag2_recorder](docs/specs/en/rosbag2_recorder.md) | Records selected ROS 2 topics to **MCAP**. The single source of truth. |
| [topic_monitor](docs/specs/en/topic_monitor.md) | Lightweight, non-intrusive live health metrics (Hz / latency / gaps / loss / bandwidth). Does **not decode** payloads. |
| [topic_probe](docs/specs/en/topic_probe.md) | A generic probe that live-plots **numeric fields** of selected topics. Decoding is **isolated** to this service so it doesn't affect recording or monitoring. |
| [webrtc_streamer](docs/specs/en/webrtc_streamer.md) | Low-latency camera **preview** (ROS 2 image → browser). Not a recording path. |
| [api_orchestrator](docs/specs/en/api_orchestrator.md) | The single API hub. Handles job lifecycle, state, configuration, and result aggregation. |
| [dora_runner](docs/specs/en/dora_runner.md) | Post-recording **validation & conversion** pipeline (dora-based). Enabled: `fast_validation` / `dataset_export` / `loss_report` / `video_check`. |
| [frontend](docs/specs/en/frontend.md) | A backend-driven Web UI (UI labels in English). Tabs: Live / Graph / Probe / Recordings / Validation / Datasets / Config. |

## Specification docs

For the detailed spec of each service, see [docs/specs/en/](docs/specs/en/README.md). Based on `fig_const/`, this is the **canonical design** (unspecified items fixed as recommended designs; no authentication).

## Getting started

### Requirements

- **Docker** / **Docker Compose** (to start all services together).
- Place sample rosbags (**MCAP**) under `data/` for local verification (e.g. `data/airoa-moma-mcap/<episode>/`). `data/` and `*.mcap` are gitignored (not committed).
- Only when running unit tests directly: **uv** (Python) and **Node.js + npm** (frontend).

### Start all services (Docker)

```bash
make up                       # = build + start (detached). Robot selected via ROBOT (default airoa_hsr)
# or with plain docker compose:
cp .env.example .env          # edit as needed
docker compose build
docker compose up
```

All services start with host networking. The ROS 2 services (`recorder` / `monitor` / `streamer`)
share the host DDS graph (`ROS_DOMAIN_ID=0`), and the pure-Python services (`orchestrator` / `dora_runner`)
and the frontend reach each other at `localhost:<port>` (no authentication; LAN assumed).

### Which `.env` file do I use? (for first-time users)

All settings live in a single `.env` file. There are **two** templates for it, so
**copy the one that matches how you plan to use kairos**. You do not need to read the whole thing.

| How you use it | Template to copy | The first line you touch |
|---|---|---|
| **① Run everything on one PC** — the normal case, and how you try the sample bag | `.env.example` | Works almost as-is. Change `ROBOT=` only when using a different robot |
| **② Record from a separate "recording PC"** — for people who don't want to load the robot itself | `.env.split.example` | Only `ROBOT_IP=` (the robot's IP address) |

> **When in doubt, pick ①.** Get it running on one PC first, then consider ② when you need it.
> In both cases, you edit the **`.env` you copied** (not the `*.example` template).
> `.env` is not committed to Git (it is `.gitignore`d).

**① Single-PC (`.env.example`)** — most people use this.
```bash
cp .env.example .env     # just copy it; it runs with almost no edits
make up
```
- To just try the sample bag (HSR), **no edits are needed** (the default `ROBOT=airoa_hsr` matches the sample).
- Only when **using a different robot**, change `ROBOT=` in `.env` to that robot's name (put its config set under
  `config/<robot>/`; see "Using additional robots" below).
- (Advanced) Only when the robot uses Cyclone DDS, change `RMW_IMPLEMENTATION=rmw_cyclonedds_cpp`.
  The other items (port numbers, etc.) can normally stay as they are.

**② Separate recording PC (`.env.split.example`)** — for recording without loading the robot.
```bash
# On the "recording PC":
cp .env.split.example .env
# Open .env and set ROBOT_IP to the robot's LAN IP (basically the only line you touch)
make recording-up
# ※ On the robot, run `make robot-up` separately (the services that touch the robot — recording,
#   monitoring, etc. — run on the robot)
```
- The only line you really edit is **`ROBOT_IP`** (the other destinations reference it automatically).
- For why it is split across two machines and the caveats (time sync, permissions, video reachability, etc.),
  see [Deployment topology](docs/specs/en/deployment_topology.md).

A full reference for every `.env` key is in the [config spec](docs/specs/en/config.md) (day to day, the above is enough).

### Make shortcuts

To avoid typing long commands every time, a `Makefile` is provided at the root. Just `make` prints the
full list of targets. Service names are **positional** (multiple allowed). A robot's config is
selected with a single `ROBOT` (default `airoa_hsr`); `make` resolves `config/<robot>/` (committed) /
`config/local/<robot>/` (gitignored) and passes the paths to each service (avoiding the stale path in `.env`).

| Command | What it does |
|---|---|
| `make up` / `make down` / `make ps` | Start the stack (with build) / stop & remove / status |
| `make build monitor` / `make build` | Build a service (positional for one / no arg or `all` for all) |
| `make rebuild frontend` | Build + force re-create (apply code changes) |
| `make restart monitor orchestrator` | Restart services |
| `make logs streamer` | Follow logs |
| `make config-reload` / `make config-show` | Apply `config/*.yaml` edits (restart monitor+orchestrator) / show current config |
| `make rosbag` / `make rosbag-loop` / `make table` | Sample bag single playback / loop playback / Hz table for all topics |
| `make smoke` / `make smoke-record` | End-to-end check (PASS/FAIL) / with record start/stop |
| `make test` / `make test-py` / `make test-fe` / `make lint` / `make fmt` | Test, lint, format |

To use a different robot, switch `ROBOT` like `make up ROBOT=<robot>` (`make` resolves `config/<robot>/`
(committed) / `config/local/<robot>/` (gitignored) and passes them to each service). For a different bag,
override like `make rosbag BAG=/data/<robot>/<run>`.

### Adding a robot (including custom message types)

Steps to add a new robot. A robot with only standard message types can skip the overlay parts of 1–3.

1. **Prepare config**: copy `config/template/` to `config/local/<robot>/` and edit it (the four aspects
   `recording/` `stream/` `validation/` `validators/`; at minimum set `default_topics` in
   `recording/default.yaml` to the robot's actual topics). Details: [`config/`](config/README.md).
2. **(Custom-type robots only) build the message overlay**: without the typesupport of the robot's
   non-standard message packages (e.g. `<robot>_msgs`), the recorder / monitor / bag playback all
   **silently drop** those topics (only standard types flow). If the bag uses **several** custom
   packages, prepare **all of them** (any one missing drops that package's topics). Place the vendor's
   msg sources under `deploy/msgs_overlay/<robot>/src/<pkg>/`, then build (procedure:
   [`deploy/msgs_overlay/`](deploy/msgs_overlay/README.md)):
   ```bash
   make msgs-build MSGS_OVERLAY_DIR=./deploy/msgs_overlay/<robot>
   ```
3. **Start up** (pass the overlay; `MSGS_OVERLAY_DIR` is unnecessary when there are no custom types):
   ```bash
   make up ROBOT=<robot> MSGS_OVERLAY_DIR=./deploy/msgs_overlay/<robot>
   ```
4. **Bag playback also needs the overlay**: `ros2 bag play` needs typesupport to publish custom types, so
   pass the same overlay to the player:
   ```bash
   MSGS_OVERLAY_DIR=./deploy/msgs_overlay/<robot> BAG=/data/<robot>/<run> \
     docker compose -f deploy/test/compose.yaml run --rm rosbag_player
   ```
5. **Smoke**: `smoke.sh` defaults to the bundled HSR bag, so for an added robot specify the bag and
   overlay explicitly:
   ```bash
   env BAG=/data/<robot>/<run> MSGS_OVERLAY_DIR=./deploy/msgs_overlay/<robot> bash deploy/test/smoke.sh
   ```
   Note that `make table` (topic_table) does not load the overlay, so an added robot's custom-type Hz is
   not shown. Use the monitor's `GET /metrics`, or the `ros2 bag info` printed at playback.

### Main endpoints (default ports)

| Service | Port | Examples |
|---|---|---|
| api_orchestrator | 8000 | `GET /api/v1/config` / `POST /api/v1/record/start` / `GET /api/v1/events` (SSE) / `POST /api/v1/jobs` |
| topic_monitor | 8001 | `GET /metrics` / `GET /topics` / `GET /metrics/stream` (SSE) / `GET /alerts` |
| webrtc_streamer | 8002 | `POST /stream/start` / `POST /stream/offer` |
| topic_probe | 8003 | `GET /topics` / `GET /fields` / `GET /stream` (SSE) |
| rosbag2_recorder | 8010 | `POST /record/start` / `POST /record/stop` / `GET /record/status` |
| dora_runner | 8020 | `POST /jobs` / `GET /jobs/{id}/result` / `POST /validation/templates/generate` |

The frontend is served by nginx (default `8080`). On startup the UI fetches `GET /api/v1/config` and
renders its tab layout and schemas backend-driven.

### Typical usage flow

1. **Stream topics**: connect a real robot/simulator, or replay a sample bag.
   ```bash
   # "see" the flowing topics (periodically show every topic's Hz/bandwidth/count)
   docker compose -f deploy/test/compose.yaml run --rm topic_table
   # replay a sample bag onto the ROS 2 graph (separate terminal; single playback)
   docker compose -f deploy/test/compose.yaml run --rm rosbag_player
   # loop playback (keep streaming continuously)
   LOOP=--loop docker compose -f deploy/test/compose.yaml run --rm rosbag_player
   # specify a different bag
   BAG=/data/airoa-moma-mcap/000730 docker compose -f deploy/test/compose.yaml run --rm rosbag_player
   ```
2. **Record**: start from the UI (Live tab) or `POST /api/v1/record/start {"topics":"all"}` → an MCAP is
   created under `/data/recorded/<run_id>/` (stop with `POST /api/v1/record/stop`). If you fill in the Live
   tab's **Operator / Task**, that content plus the topics, count, and start/end are saved to
   `/data/recorded/<run_id>/session.json` in the same directory as the MCAP, and are also shown in the
   Recordings tab. A recording can be **deleted from the Recordings tab** (deletes the DB row +
   `/data/recorded/<run_id>`). The recorder `chmod 0777`s its output, so it can also be deleted from the
   host side (outside the container) without sudo.
3. **Monitor / preview**: live health (Hz / gaps / bandwidth) via `GET /metrics`, WebRTC camera preview via
   `/stream`. The UI's Live tab fuses the Stream preview and the Monitor panel (**always shows every topic on
   the graph**, overlaying live Hz on the monitored ones). The sample bag's Hz shows up with the default
   `ROBOT=airoa_hsr` (which topics to record/monitor is defined per robot in
   [`config/`](config/README.md); reflected as a pre-selection in the Live tab's RECORD checks).
4. **Post-recording validation & processing** (via `POST /api/v1/jobs`, through `dora_runner`):
   - `fast_validation` — validates the presence/absence of required topics → `pass`/`fail` in `/data/report/fast_validation/<run_id>/summary.json`.
   - `loss_report` — per-topic loss estimation (Recordings tab's "Run loss report").
   - `video_check` — mp4 preview of camera topics (Recordings tab; play via `GET /api/v1/files/...`).
   - `dataset_export` — export a completed recording to `data/<operator>/<task>/NNN` (Datasets tab).

### Tests / integration tests

- **Unit tests**: `make test` (= each Python service `uv run --extra test pytest` + frontend `npm run build && npm test && npm run lint`).
- **Smoke test (prints PASS/FAIL)**: after the stack is up, `make smoke` (= `bash deploy/test/smoke.sh`).
  It validates health → `GET /api/v1/config` `default_topics` → topic discovery → the monitor's live metrics, in order, and
  prints the result (`make smoke-record` also runs record start/stop). This is the entry point for resolving "I tested it but nothing comes out."
- **Playback with visualization**: `make table` (periodically show Hz/bandwidth for all topics) and `make rosbag` / `make rosbag-loop` (playback).

For detailed commands and verified recipes, see "Build / test / run commands" in [CLAUDE.md](CLAUDE.md).

## Documentation language rule

**Japanese is the source of truth.** Edit the Japanese files (`*.ja.md`), and regenerate the English
versions (`*.md`) with the `/sync-docs` skill. Do not edit the English versions by hand.

## Contributing

- Write code, comments, and commit messages in English.
- For working conventions and rules, see [CLAUDE.md](CLAUDE.md).
