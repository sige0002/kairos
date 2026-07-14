# Changelog

All notable changes to kairos are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The single source of
truth for the current version is the root [`VERSION`](VERSION) file.

## [Unreleased]

Phase A hardening toward a supportable release
(see `dev_docs/improvement_plan_2026-07-14.md`).

### Added

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
