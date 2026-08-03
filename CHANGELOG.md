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
- COVERAGE side card on Collect: per-condition recorded counts for the current
  task (summing the monotone `episodes_recorded`, which nothing ever lowers, so
  the figure survives a later exclude or delete) — "what to record next" as a
  data decision.
- Datasets label filters (task result / condition / operator) and
  "Manifest (n)": download the filtered rows as a manifest JSON — a versionable
  training-set definition (2026-07-14 second split hearing: no physical
  success/failure split).
- Review batch filter + batch-level bulk decisions: clicking a row's batch
  chip filters to that batch; "Exclude batch (n)…" (reversible, kept on disk,
  per-row failure reporting) and "↺ Return batch (n)" act on the whole batch —
  the one-action consequence of a failed per-batch validation.
- Per-batch bulk validation: the Validation target selector gains a "Batches"
  group that runs the selected pipeline over every capture in a batch (the
  blast-radius check for defects that cluster per batch).
- Batch labels are now queryable at the consumption end (2026-07-14 decision):
  a capture carries `batch_id` (globally unique; `batch_seq` resets daily) and
  its batch's `condition`, so a training-set assembler can exclude whole batches
  or filter by condition without opening each recording. The Datasets screen
  shows the condition and the downloadable manifest carries both.
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

- **Collect's Discard is one click** (user decision 2026-08-03). The reason
  prompt had already been softened to preset chips; the same feedback said the
  clicks themselves were the burden, so on Collect the press is now the
  consent — no dialog, no typed reason, immediate discard of the take on the
  result panel and of an unsaved take from the recovery banner. The ledger
  still gets a true answer: an automatic reason recording that the discard
  came from Collect and no reason was asked, which keeps a Collect tombstone
  distinguishable from a Review discard. Review's dialog (and §12's wording
  obligations) are unchanged; on a split deployment the "this machine's copy
  only" disclosure moves into the success toast, and a refusal (the job-voiced
  `capture_busy` text included) lands on the toast with the take kept — retry
  is the same press.

- **Capture store v2 — recordings are now addressed by `capture_id`, and
  `kairos.db` is disposable.** A recording is a *capture*: a recorder-minted
  UUIDv7 that names one directory, `objects/<capture_id>/`, and one row. The old
  split between "the run" (what was recorded) and "the episode" (what the
  operator decided about it) is gone — one capture carries both, so listing,
  reviewing, deleting and archiving are all one key. `run_id` survives as a
  **display name only**: it is never a path, a foreign key, or an API key again.
  The full design is now a first-class spec, `docs/specs/ja/capture_store.md`.

  The change that everything else follows from: **the sidecars on disk are
  canonical and the database is an index of them.** `object_manifest.json`
  (recorder facts, one file replacing `manifest.json` + `session.json`),
  `record.json` (the operator's review, authoritative over the DB for review
  fields), and `lifecycle.jsonl` (what was destroyed or declared) are enough to
  rebuild the whole catalog. Deleting `kairos.db` and restarting is a supported
  recovery, exercised by an acceptance scenario rather than asserted.

  Deletion stopped being an `rm`. Discard and delete share one five-step
  pathway — append to the ledger (fatal: no ledger line, no deletion), mark the
  row `delete_pending` as a durable pre-rename marker, rename into `.trash/`,
  commit the tombstone, then reap — and the row **survives as a tombstone**, so
  "where did that recording go" stays answerable. A crash at any step is
  finished on the next startup, which rescans the ledger every boot precisely
  because a crash between step 1 and step 2 leaves no row to find. Files that
  vanish *outside* kairos are not treated as deletions at all: the replica goes
  `missing_unmanaged` and surfaces as a warning, and a reconciler pass that
  finds too many missing at once (`max(5, 10%)`) refuses to apply itself and
  latches SUSPECT until an operator confirms the volume with Repair — an
  approval given while the volume marker is unreadable is refused, because
  "yes, those really are gone" cannot be meant about a disk nobody can identify.

  Datasets became logical. No physical move, no copy: a dataset is rows plus
  ledger events, and the human-readable `views/<operator>/<task>/<name>/<NNN>`
  symlink tree is regenerated from committed memberships through a generation
  directory and one atomic flip, so `views` never stops resolving. Archive
  survives as a capture-unit operation (`POST /api/v1/captures/{id}/archive`)
  that copies, verifies, records per-file `{path,size,sha256}` in the ledger,
  and only then removes the source — with destination guards that refuse an
  overlap with the data directory in both directions.

  dora_runner jobs take `capture_id`, resolve their source as
  `objects/<capture_id>`, and write `report/<pipeline>/<capture_id>/`. They
  never write inside `objects/`, which is why they can stay lease-ignorant: the
  orchestrator holds the §7.1 capture lease on their behalf, renewing it
  whenever it observes a live job. That guarantee is stated honestly in the code
  and the spec — it covers a job someone is watching, **not** an unbounded queue
  wait, where a delete may win and the job then fails cleanly on a directory
  that moved to `.trash`.

  Split deployments keep working: `import_runs.sh` discovers terminal
  `object_manifest.json` files, stages into `.incoming/<capture_id>`, and moves
  into `objects/` with one same-filesystem rename, so a partially arrived
  transfer can never look complete. The importer's `/pull` now takes
  `{"capture_id": …}` or an explicit `{"all": true}` and rejects anything else,
  because the old lenient empty body would have turned one mis-keyed request
  into a full sweep of the robot.

  Acceptance moved to the UI. `make test-e2e` drives a real browser against a
  real stack (own ports, own data dir, own compose project, looping bag replay)
  through five scenarios: record and stop on Collect until the capture verifies;
  save a review and have a stale save refused out loud; discard behind its
  reason-required dialog and find the tombstone in the ledger; delete
  `kairos.db`, restart, and get everything back; and `rm -rf` a capture's
  directory, see SUSPECT, acknowledge it with Repair, and find the capture
  marked missing rather than silently dropped. Note that it does **not** build
  images, by the same rule as `make up` — run `make build` after changing code,
  or the gate tests stale containers.

  **Breaking changes.** This is an alpha reset: there is no migration and no
  compatibility alias, and existing data is not read.
  - Retired endpoints (see *Removed*): all of `/api/v1/runs`, all of
    `/api/v1/episodes`, the physical dataset-tree routes, the index rebuild and
    the export routes.
  - Layout: `recorded/<run_id>/`, the `<operator>/<task>/<NNN>` dataset tree,
    `data/index.jsonl`, `dataset.json`, `episode.json`, `manifest.json` and
    `session.json` are gone. `objects/`, `views/`, `.trash`, `.incoming`,
    `report/`, `catalog/`, `lifecycle.jsonl`, `instance.json` and `kairos.db`
    are reserved names directly under the data directory, and `objects`,
    `.trash` and `.incoming` must share one filesystem (checked at startup; the
    delete and archive routes stay registered but answer `503
    delete_unavailable` per request, rather than silently degrading to
    copy+delete).
  - `lifecycle.jsonl` starts fresh in the v2 shape; the v1 format is not read.
  - No database migration exists, by design: the schema change is absorbed by
    rebuilding from the sidecars, which is the first-choice mechanism for
    schema changes from here on.
  - The `dataset_export` and `dataset_archive` pipelines, the `dataset_dir` job
    param and the `bag_local` boolean are removed. The plugin env var
    `KAIROS_RUN_ID` is **renamed to `KAIROS_CAPTURE_ID`** (and carries a
    capture_id, not a run_id); a flow still referencing `${KAIROS_RUN_ID}` now
    hits an unknown token, which is an error rather than a silent
    pass-through.
  - `POST /api/v1/transfer/pull` is rekeyed from `{"run_id": …}` to
    `{"capture_id": …}`, and omitting the key now means an explicit
    `{"all": true}` sweep on the importer rather than an empty body — the
    importer rejects an empty body with a `400` so that a lost key can never
    quietly widen a targeted pull into a sweep of the robot.
  - Retention's definition changed: "a row still exists, therefore it was never
    exported" is meaningless now that rows outlive deletion, so a candidate is a
    capture no dataset cites, left `pending` or `excluded`, older than
    `RETENTION_DAYS`.

- Agent instructions reorganized around `AGENTS.md`: the working rules shared by
  every coding agent and by humans (project status, layout, stack, code
  conventions, build/test/run commands, git rules) now live in a single
  Japanese `AGENTS.md`, which Codex-style agents read directly. `CLAUDE.md`
  imports it with `@AGENTS.md` and keeps only Claude Code specifics (skills,
  parallel-session isolation, how to approach a change). `CLAUDE.ja.md` is
  removed — these two files are Japanese-only and have no English mirror,
  the one exception to the Japanese-canonical / English-mirror doc rule.

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

- **The v1 recording API surface, with no compatibility aliases** (see the
  capture store v2 entry under *Changed* for what replaces each):
  `GET/DELETE /api/v1/runs` and `/api/v1/runs/{id}`; `POST/PATCH
  /api/v1/episodes` and `/api/v1/episodes/{id}`; `GET/DELETE
  /api/v1/datasets/{operator}/{task}/{index}`; `POST
  /api/v1/datasets/index/rebuild`; `POST /api/v1/datasets/export` and
  `/export-all`. Also retired: the `lifecycle_ledger` v1 module (ledger_v2 is
  the only writer), `Settings.recorded_dir`, the legacy v1 frontend tabs
  (`RunsTab`, `DatasetTab`, `inspect`) and the in-browser `episodeBridge`.

- The Review signals-defaults config aspect, retired with the waveform chart
  it configured: `GET/PUT /api/v1/config/signals`, the Settings > Data
  quality SignalsCard, `signalDefaults.ts`, and `config/<robot>/signals/`.

### Fixed

- **Dataset rows now identify the recording, not just its directory** (user
  report 2026-08-03: "run ID だけではどのデータかわからない"). The build
  rail's candidate rows and the member table led with `run_id`, and same-day
  runs differ only in their final digits, so the operator could not tell which
  data they were adding. Every row now leads with when the recording was taken
  (date included — the rails mix days, unlike Review's one-batch view) and
  what it was (task · operator · duration · size), with the run name kept as
  the secondary, on-disk line (§1: display only). The member detail already
  carried these facts; only the lists were bare.

- **A rejected pre-arm no longer surfaces only after the next rebuild**
  (found live by the acceptance suite, 2026-08-03: §13-4 went red because a
  capture appeared out of nowhere after `rm kairos.db`). When Collect's
  keep-alive `/record/prepare` fails to arm, the recorder writes
  `objects/<id>.failed.json` before rejecting — but the orchestrator filed no
  row for it, by documented design, so the store contained a failure only a
  rebuild would admit to and the operator saw different catalogs before and
  after the index was rebuilt. The failed row is now filed the moment the
  rejection arrives, on the start and prepare paths alike; a rejection that
  names no capture_id still files nothing (no id was minted, so there is no
  sidecar either). The §13-4 spec's expected set now comes from the store's
  own account at the last moment before the index dies, so a background
  failure landing after the list painted cannot read as "the rebuild invented
  a capture".

- **A dead camera source reads "topic silent" even outside the monitored set**
  (follow-up to the QA cycle's camera-tile honesty work). Discovery's
  `publisher_count` rides into the monitor rows, and zero publishers means
  nothing can be producing frames — the topic stays on the graph only because
  something subscribes to it, the streamer's own preview subscription
  included. Such a tile used to give the weaker "not monitored — no rate
  available" answer. Measured traffic still outranks the count, so a restart
  flap cannot flip a measured-live tile; real silence arrives as the monitor's
  own `inactive`.

- **`make test-e2e`'s own teardown no longer warns about itself.** The run
  lease names make as the owner, but make executes the teardown through an
  intermediate `sh -c`, so a plain pid comparison called every green run's
  own `down` a foreign release. Self is now the whole ancestor chain; a
  genuinely foreign release still warns, and a live foreign `up` is still
  refused.

- **Live claims now expire — the fresh-eyes QA cycle** (5 rounds, 2026-08-02
  〜08-03). An independent exploratory QA pass over the real UI found the
  product's slow paths scrupulously honest and its fast paths not; every
  finding is fixed and re-verified against disk and manifest, not the screen.
  Headlines: a dead recorder can no longer keep a RECORDING card counting
  (nor, after returning, resurrect a recording that no longer exists — the
  interrupted take is offered with its real bytes and the recorder's own
  reason); the catalog can no longer contradict a terminal manifest
  (`adopt_manifest_facts` behind all three settling paths — an interrupted
  take's 10.7 MB was being described as "0 B / verified (empty)" with an
  irreversible Discard as the invited next step); the quick check gained a
  minimum-duration criterion (an accidental 87 ms double-click take can never
  verdict GOOD); camera tiles cross-reference the SOURCE topic's liveness
  ("topic silent — showing the last frame" / "not monitored — no rate
  available") instead of trusting a transport that re-encodes a frozen frame
  at a real 15 fps; per-capture video jobs are serialized (five previews no
  longer burst into four 409s); discarding an obviously-bad take is one click
  (preset reason chips, free text only behind Other, and an abandoned Other
  text can never contaminate the ledger); and a schema change that shipped
  without a version bump — breaking every `POST /jobs` on live databases —
  forced the rule into the constant's own comment. The recorder-honesty arc
  is pinned as E2E scenario 06.

- **A Stop now actually stops** (user report 2026-07-27). `POST /record/stop`
  treated "no run row claims to be recording" as "nothing is recording" and
  returned the last run with `200` — but a row can be missing or in the wrong
  state, so a recorder still writing answered the operator's Stop with success.
  The console then advanced to labelling a take that was still being recorded,
  and only the `MAX_RECORD_SECONDS` backstop ever ended it. The stop now asks
  the recorder what it is actually doing: a run with a row is adopted and
  finalized normally, an orphan with no row is stopped anyway, and both are
  logged at WARNING. The console no longer trusts the `200` on its own either —
  it confirms against `/record/status` and, if the recorder is still recording,
  stays on SAVING with `Retry stop` instead of pretending the take is done.
- **A stale `record_status` SSE event can no longer rewind the UI.** The event
  writer set the cached state unconditionally, so an event arriving late could
  move it back to `recording` — which is exactly what renders the takeover card
  ("RECORDING IN PROGRESS") over a take the operator already stopped. Rewinds
  are dropped within a run (a different run_id is not a rewind) and logged as
  ignored rather than swallowed.
- **Collect's Active warnings no longer calls a live topic dead** (user report
  2026-07-27). The recorder's arming snapshot was frozen at the FIRST prepare
  and never re-read, so a target that was down then — and live seconds later —
  stayed "not publishing" through every pre-arm keep-alive, through the start,
  and for the whole recording, while Monitor showed it at full rate. The graph
  is now re-read while armed and frozen at resume (real start-time coverage),
  and `RecordArming` gains `unsubscribed_topics` so "no publisher" and
  "published but the recorder has not subscribed yet" are reported as the
  different problems they are.
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
