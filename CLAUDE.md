<!-- AUTO-GENERATED from CLAUDE.ja.md. Do not edit by hand — edit the Japanese source and run /sync-docs. -->

# CLAUDE.md

Working notes for Claude Code (and humans) in this repository.
Project overview: [README.md](README.md) (日本語: [README.ja.md](README.ja.md)).
The current design lives in `docs/specs/ja/` (the **canonical** version, based on the `fig_const/` diagrams). Read those for detail; do not restate them here.

> Status: **greenfield, pre-design.** Code and tech stack are undecided. Directory structure is agreed only at the container level (each service's internals are TBD).
> **Do not make design decisions** — decide them *with the user*. Leave unknowns as **TBD**.

## Documentation language rule (important)

- Documentation is authored in **Japanese as the source of truth.** The author edits only the Japanese files (`*.ja.md`).
- English files (`*.md`) are **auto-generated mirrors** — do not edit them by hand. Regenerate them from the Japanese with `/sync-docs`.
- **Code, comments, identifiers, and commit messages are in English.**

## Conventions

- The directory structure is **agreed only at the container level** (see below). Backends are basically **Python**, the frontend is **TS** (→ Stack). Code conventions and the test approach also have an agreed baseline (below).
- API contracts, each service's internal details, and per-service build/run commands are **not decided yet — TBD.**

## Sample data (for local verification)

- For local verification, place sample rosbags (**MCAP**) under `data/`.
- Example: `data/airoa-moma-mcap/<episode>/` (each with `<id>.mcap` + `metadata.yaml`). HSR robot teleoperation recordings (AIROA MOMA) — raw MCAP that serves as the canonical recording.
- **MCAP is the canonical recording format** and the input to the validation/conversion pipeline.
- The contents of `data/` are `.gitignore`d (`data/.gitkeep` keeps only the directory tracked, so the `./data`→`/data` mount is created user-owned, avoiding a root-owned mount). `*.mcap` and sample data are not committed.
- This is a local convenience, **not a decision on the official repository layout** (layout is TBD).

## Repository layout

Agreed only at the container level (**1 folder = 1 container image**, 1:1 with the diagram boxes). Each folder's internals (`src/` / `tests/` / `Dockerfile`, etc.) and each service's stack are **TBD** (details go in `docs/`).

```
kairos/
├─ services/              # one container each (1:1 with the diagram boxes)
│  ├─ rosbag2_recorder/   #   ROS 2: topics → MCAP (canonical recording)
│  ├─ topic_monitor/      #   ROS 2: live monitoring metrics
│  ├─ webrtc_streamer/    #   ROS 2: low-latency camera preview
│  ├─ api_orchestrator/   #   API hub / job & state management
│  ├─ dora_runner/        #   post-recording validation & conversion (dora)
│  └─ frontend/           #   Web UI (Vite + React + TS)
├─ libs/                  # shared across services (API contracts / ROS msgs / common utils)
├─ config/                # recording/monitoring config (which topics to record · RECORDING_CONFIG)
├─ deploy/                # orchestration helpers (env / k8s / integration test harness)
├─ Makefile               # shortcuts for docker compose + the test harness
├─ compose.yaml           # root entry point (docker compose)
├─ docs/                  # specs & design docs
└─ data/                  # runtime data (gitignored)
```

- See `docs/specs/ja/<service>.md` (English mirror: `docs/specs/en/<service>.md`) for each service spec.
- The folders don't exist yet (this only records the agreed structure). Scaffolding will be done separately.

## Stack

> Agreed baseline only. Per-service details go in `docs/` once decided.

- **Backends are basically Python.**
  - ROS 2 nodes (`rosbag2_recorder` / `topic_monitor` / `webrtc_streamer`): **rclpy**.
  - `api_orchestrator` / `dora_runner`: Python (framework, etc. TBD).
- **frontend**: Vite + React + TypeScript (decided).
- ROS 2 distro: the test harness defaults to **Jazzy** (override with `ROS_DISTRO`).
- Each service is self-contained (1 folder = 1 image); dependencies stay within the service.

## Code conventions

- **Code, comments, identifiers, and commit messages are in English** (see the language rule).
- **Python**
  - Formatter / linter: **Ruff** (format + lint). Line length: Ruff default (88).
  - Types: add type hints to public interfaces. `mypy` is optional (introduce gradually in CI).
  - Tests: **pytest** (use `launch_testing` optionally for ROS 2 node integration).
  - Packaging: a `pyproject.toml` (PEP 621) per service.
- **TypeScript / frontend**: ESLint + Prettier, Vitest for tests, strict `tsconfig`.
- The above is the agreed baseline. Split any per-area extra rules into `docs/`.

## Build / test / run commands

> All 6 services + the frontend are implemented (Stage 1–4). The most important section of this file.

- **Make shortcuts (the recommended entry point)**: the root `Makefile` thinly wraps the commands
  below. Run `make` for the target list. Service names are **positional** (`make build monitor`,
  `make restart monitor orchestrator`). A robot's config is selected with a single `ROBOT`
  (default `airoa_hsr`); `make` resolves `config/<robot>/` (committed) / `config/local/<robot>/`
  (gitignored) and derives the recording/stream/validation/validators paths for each service
  (avoiding the stale path in `.env`). Key ones: `make up` /
  `make rebuild <svc>` / `make restart <svc>` / `make logs <svc>` / `make config-reload` (apply config
  edits) / `make rosbag-loop` / `make table` / `make smoke[-record]` / `make test` / `make lint` /
  `make fmt`. The rest of this section documents what each command runs.
- **Unit tests (Python)**: inside each service / the shared library, `uv run --extra test pytest -q`.
  ```
  for d in libs/kairos_common services/rosbag2_recorder services/topic_monitor \
           services/webrtc_streamer services/api_orchestrator services/dora_runner; do
    (cd "$d" && uv run --extra test pytest -q)
  done
  ```
  The ROS nodes (recorder/monitor/streamer) **lazy-import** rclpy, so the pure-logic tests run even on a host without ROS (the rclpy-dependent paths are verified in Docker).
- **Unit tests (frontend)**: `cd services/frontend && npm run build && npm test && npm run lint`.
- **Lint / format**: `uvx ruff check libs services` / `uvx ruff format libs services`.
- **Build**: each service builds to one image from its own `Dockerfile`. Build all with `docker compose build`, start with `docker compose up`.
- **Integration tests (real-data replay)**: a **rosbag2 replay + visualization container** is provided.
  - Definition: `deploy/test/` (`Dockerfile` + `compose.yaml` + `topic_table.py` + `smoke.sh`).
  - Shares `data/` as a **volume** (read-only mount at `/data`) and streams recorded MCAP onto the ROS 2 graph.
  - **`ROS_DOMAIN_ID=0`**, `network_mode: host` / `ipc: host` (shares the host's DDS graph and SHM).
  - Two services (**use them together in separate terminals**):
    ```
    # ① "see" what is flowing (periodic table of every topic's Hz/bandwidth/count)
    docker compose -f deploy/test/compose.yaml run --rm topic_table
    # ② play a bag once (prints `ros2 bag info` first, then plays). LOOP=--loop to repeat.
    docker compose -f deploy/test/compose.yaml run --rm rosbag_player
    BAG=/data/airoa-moma-mcap/000730 docker compose -f deploy/test/compose.yaml run --rm rosbag_player
    ```
  - **Smoke test (prints PASS/FAIL)**: once the stack is up, `bash deploy/test/smoke.sh`.
    It checks health → `GET /api/v1/config` `default_topics` → topic discovery → the monitor's live
    metrics, in order, and prints the result (`RECORD=1` also runs record start/stop). The entry point
    for fixing "nothing comes out."
  - **The config entry point is `config/`** (formerly `deploy/config/`). `RECORDING_CONFIG` points at one
    file. See [`config/README.md`](config/README.md).
  - Verified integration recipes (key points):
    - **Stage 1 recording**: confirm topics are established with `topic_table` → `POST /record/start {"topics":"all"}`
      to the recorder (the orchestrator assigns the run_id) → MCAP is created under `/data/recorded/<run_id>/`.
      Recording several thousand messages from the sample bag is confirmed by `smoke.sh RECORD=1`.
    - **Stage 2 monitoring**: the default **`ROBOT=airoa_hsr`** matches the sample bag's (HSR) `/hsrb/*`,
      so starting the monitor as-is shows real Hz/bandwidth for `/hsrb/*` in `GET /metrics` (selecting a
      different robot's config whose `default_topics` don't match can leave metrics empty = no Hz in the
      Monitor tab. The Monitor tab itself always lists every topic via discovery).
    - **Stage 3 validation**: run `dora_runner` standalone + `POST /jobs {pipeline:"fast_validation", run_id, params:{template}}`, or via the orchestrator `POST /api/v1/jobs`. Writes `result: pass|fail` to `/data/report/fast_validation/<run_id>/summary.json`. MCAP is read directly with `mcap` + `mcap-ros2-support` (no ROS needed).

## Specification docs

Per-service specs live in `docs/specs/ja/<service>.md` (English mirror: `docs/specs/en/<service>.md`). Based on `fig_const/`, this is the **canonical design** (unspecified items fixed as recommended designs; no authentication). Shared config: [`docs/specs/en/config.md`](docs/specs/en/config.md).
