# Changelog

All notable changes to kairos are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The single source of
truth for the current version is the root [`VERSION`](VERSION) file.

## [Unreleased]

Phase A hardening toward a supportable release
(see `dev_docs/improvement_plan_2026-07-14.md`).

### Added

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
