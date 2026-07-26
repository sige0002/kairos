# Changelog

All notable changes to kairos are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The single source of
truth for the current version is the root [`VERSION`](VERSION) file.

## [Unreleased]

Phase A hardening toward a supportable release
(see `dev_docs/improvement_plan_2026-07-14.md`).

### Added

- `full_validation` on **real dora**: the placeholder pipeline is now a
  declarative post-recording gate. A robot's `config/<robot>/flows/<flow>.yml`
  is a bagflow flow (vendored into `services/dora_runner/bagflow/` together with
  mcap2dora — see its `VENDOR.md`), materialized per job (bag/report injection,
  `${KAIROS_*}` expansion, node-path resolution) and executed by the bundled
  bagflow CLI + dora 0.5 CLI on a coordinator the service starts on its own
  loopback ports (so a co-located dora_live is never touched). bagflow's
  `report.json` is adapted to kairos' `summary.json` contract, with the overall
  pass/fail decided in dora_runner: any failed check, any node that died before
  end-of-stream, no results at all, or coverage below `params.min_coverage`.
  The Config tab's validation template feeds the flow as `${KAIROS_EXPECT_HZ}`
  (required topics enter at `hz=0` = must exist), merged with the recording
  config's `expected_hz_patterns`. Measured 0.57s wall for the 6-node quick gate
  on the bundled 44s HSR sample. Image gains the Rust nodes + dora CLI
  (357 MB → 477 MB) and compose gains `shm_size: 2gb` (dora queues live in
  `/dev/shm`; the 64 MB default kills nodes silently). Where the binaries are
  absent (source checkout / CI) the pipeline stays an honest `enabled=false`
  placeholder and `/readyz` reports `components.bagflow: unavailable`.
- Collect operator early-warning integration: the Active warnings card now
  unions the arming snapshot's missing targets with FIRING monitor alerts
  (SSE buffer, restricted to recorded topics) so mid-recording degradation —
  the hole the resume-frozen arming snapshot cannot see — surfaces where the
  operator is looking, with measured values and an Open-in-Monitor path; the
  System status card gains a `Topic rates` row (`N / M at expected`, from the
  monitor's per-topic status; no composite health score by design).
- `x-suggest` form annotation: a pipeline's `params_schema` can mark a string
  param as `"camera_topics"` / `"topics"` and the Validation tab renders it as
  a picker over the selected target run's real topics (first one auto-seeded)
  instead of a hand-typed path — video_check's `topic` uses it; plugins can
  too. Falls back to free text when no candidates exist (dataset targets).
- Plugin artifact visualisation (zero-UI-edit graphs): the orchestrator
  normalises `GET /jobs/{id}/result` artifact paths to data-root-relative,
  making each fetchable via `GET /api/v1/files/{path}`; the generic
  `SummaryResult` renderer shows image artifacts (png/jpg/svg/gif/webp)
  inline and other files as download links — a dora plugin that writes
  `plot.png` into its report dir gets a graph in the Validation result view
  without touching the frontend.

- Stop-time quick check settlement: when a recording stops, the orchestrator
  settles a two-layer quick check off the stop path (Layer 0 = monitor window
  deltas + incidents + recorder integrity; Layer 1 = MCAP summary-section read,
  no message scan) and persists a `quick_check` verdict (good / needs_review
  with specific per-topic reasons) on the run; episode saves derive their
  default `quality` from it (`quality_source: "quick_check"`). Honest
  degradation: each layer carries an `available` flag and a missing bag summary
  is itself a needs_review signal.
- Derived hz alert rules: every monitored topic with an `expected_hz` and no
  explicit alerts.yaml rule now auto-gets a shortfall rule (WARNING < 0.8×,
  DANGER < 0.5× expected; tunable via `derived_rules:`). Incidents carry a
  `rule_origin` (config / derived / default), and `GET /incidents?since_ns=`
  serves a bounded fired/cleared incident history so the stop-time quick check
  can settle "what fired during this recording".
- `signal_report` dora pipeline: generic post-hoc numeric time-series
  extraction from a recorded MCAP (any topic with numeric leaves — joints,
  wrench, odom, cmd_vel; image topics are skipped toward video_check). One
  scan extracts every numeric leaf (shared live-Signals path vocabulary via
  `kairos_common.field_introspect`), downsamples to ≤ max_points with
  episode-relative `t_ns`, and computes a per-topic continuity score whose
  formula ships inside the sidecar.
- Review detail: a Signals section (topic + field-path picker, uPlot chart,
  continuity chip with its definition, per-topic time source) and
  chart↔video synced playback — the playhead tracks `video.currentTime` and
  clicking the chart seeks the video, enabled only on a full-length
  (`max_frames: 0`) render so a head-capped preview never lies about episode
  time. The QUICK CHECK verdict and its reasons render on the episode detail.
- Review layout: the detail pane is now viewport-elastic
  (`minmax(400px,1.2fr)`) and the FILTERS rail collapses to a slim rail
  (persisted, keyboard-accessible) so charts and synced video get the width
  they need on operator screens.
- Batch targets are per-batch and editable (Collect's Batch menu "Change
  target…", `PATCH /batches/{id} target_episodes` 1–500): the strip, counters
  and completion all follow the batch's own plan size instead of a fixed 30.
- COVERAGE side card on Collect: per-condition "recorded / exported" counts
  for the current task (recorded sums the monotone `episodes_recorded`, so
  exported takes still count) — "what to record next" as a data decision.
- Datasets label filters (task result / condition; unlabeled exports only pass
  "All") and "Manifest (n)": download the filtered rows as a manifest JSON —
  a versionable training-set definition (2026-07-14 second split hearing:
  no physical success/failure split).
- Review batch filter + batch-level bulk decisions: clicking a row's batch
  chip filters to that batch; "Exclude batch (n)…" (reversible, kept on disk,
  per-row failure reporting) and "↺ Return batch (n)" act on the whole batch —
  the one-action consequence of a failed per-batch validation.
- Per-batch bulk validation: the Validation target selector gains a "Batches"
  group that runs the selected pipeline over every unexported run of a batch
  (the blast-radius check for defects that cluster per batch).
- Batch labels are now queryable at the consumption end (2026-07-14 decision):
  `data/index.jsonl` catalog rows and `GET /api/v1/datasets` list rows carry
  `batch_id` (globally unique; `batch_seq` resets daily) and `condition`
  (flattened from episode.json's batch context), so a training-set assembler
  can exclude whole batches or filter by condition from one file. Pre-existing
  rows heal via `POST /api/v1/datasets/index/rebuild`. Dataset cards show the
  condition; the detail's Sidecars section now includes the episode.json block.
- Shared plan catalog `GET/PUT /api/v1/plans` (single-row `plan_catalog`
  table): the project/task/condition vocabulary is persisted server-side and
  reconciled once per page load (seed a never-set server, push dirty local
  edits, otherwise adopt the server copy), so labels stay aggregable across
  terminals. Not the Phase 2.5 Plan model (no ids/refs/targets).
- Monitor sub-views implemented on real data: Overview (diagnostic landing),
  System, Events (incident history with filters), Logs (session event
  timeline); Settings sections implemented: Recording (form-first, JSON as
  Advanced), Data quality, Validation, System. Dataset profiles and
  Users & permissions remain honest placeholders with stated rationale.

- Continuous integration (`.github/workflows/ci.yml`) run on every push and pull
  request to `develop` / `main`: Python unit tests for the shared library and all
  six Python services, frontend build + test + lint, Ruff lint and format checks,
  and `docker compose config` validation of every compose file.
- ROS integration CI (`.github/workflows/ros-integration.yml`): the recorder's
  real `ros2 bag record` round-trip test, run inside a `ros:jazzy` container. It
  is a separate workflow because it needs the ROS 2 toolchain (the plain-runner
  suite skips it), and it runs on push/PR plus manual dispatch.
- Release engineering scaffolding: a root `VERSION` file and this changelog.
  Compose image tags are now driven by `KAIROS_VERSION` (read from `VERSION` by
  the Makefile), so `make build` / `make up` tag the orchestrator, dora_runner,
  and frontend images with the release version instead of a mutable `:latest`.

### Changed

- Review detail: the Signals section became "Data integrity" — synced video
  first, an aggregated one-lane integrity timeline directly under it (worst
  condition across topics per bin; click-to-seek; empty-bin-red restricted to
  dense topics after real-data verification showed ~10 ms bins vs 20–30 ms
  message periods painting healthy episodes solid red), a ranked loss-event
  table (majors first, top 8, explicit "Show all n"), and a per-topic
  continuity summary. The raw per-field waveform chart and its field pickers
  were removed (a joint-angle plot doesn't answer "is this episode usable";
  live waveforms remain in Monitor > Signals via topic_probe).

- Reproducible image builds: every Python service Dockerfile installs its
  dependencies from the committed `uv.lock` (`uv sync --frozen`) instead of
  re-resolving `>=` specifiers at build time, and all previously floating base
  images (`python:3.12-slim`, `node:22-slim`, `nginx:1.27-alpine`,
  `ghcr.io/astral-sh/uv:latest`) are pinned to a specific patch tag + digest.
- `topic_monitor`'s container healthcheck now probes `/readyz` — its readiness
  reflects its own subscriber state, so an unhealthy monitor really is one that
  cannot serve metrics. The orchestrator deliberately keeps `/healthz` for
  container health: its `/readyz` includes downstream dependencies, so driving
  the healthcheck off it would restart the orchestrator whenever the recorder is
  down (documented inline in `compose.yaml`).

### Removed

- The Review signals-defaults config aspect, retired with the waveform chart
  it configured: `GET/PUT /api/v1/config/signals`, the Settings > Data
  quality SignalsCard, `signalDefaults.ts`, and `config/<robot>/signals/`.

### Fixed

- Review now shows WHY a task failed (user report 2026-07-14): the
  `failure_reason` picked at save time surfaces as the FAILURE chip tooltip
  (Review list + Datasets cards) and in the Review detail panel; it also rides
  the dataset catalog rows. The value was persisted all along — no UI rendered
  it.
- Collect episode strip off-by-one (user report 2026-07-14): chips now sit on
  their true `index_in_batch` instead of array position, so a Review
  export/delete no longer slides later chips left and makes the newest episode
  read as "not recorded"; a missing recorded number renders as an honest dashed
  "no longer listed" chip. A server-reallocated save index is adopted locally,
  and the once-per-load server restore now MERGES same-batch local episodes the
  server doesn't know about (bridge-only / unlanded POST) instead of dropping
  the just-saved chip; a restore onto a different batch no longer inherits the
  local recorded count.
- Datasets left list scroll containment (user report 2026-07-14): the screen
  grid pins its single row to the viewport (`minmax(0,1fr)`) and the list
  scrolls inside its own column with a pinned header, so older datasets stay
  reachable regardless of count or layout engine.

## [0.1.0] - 2026-07-14

First tagged release.

Console v2 (role-based 6-tab operator UI) on the full recording pipeline: ROS 2
rosbag2 recording to MCAP, live monitoring with incident alerts, WebRTC camera
preview, batch/episode labeling persisted server-side, exception-review export to
labeled datasets, and dora-based validation. Includes the persona-R2 HCD
remediation (server-truth recording state, honest quality provenance, resumable
stop-save, keyboard flow) and the recording duration/byte backstops. Single-PC
and split (robot / recording PC) docker compose deployments; trusted-LAN, no-auth
scope.

[Unreleased]: https://github.com/sige0002/kairos/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/sige0002/kairos/releases/tag/v0.1.0
