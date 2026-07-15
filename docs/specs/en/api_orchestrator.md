<!-- AUTO-GENERATED from docs/specs/ja/api_orchestrator.md. Do not edit by hand — edit the Japanese source and run /sync-docs. -->
# api_orchestrator specification

> Status: design finalized (v1). Based on `fig_const/apiオーケストラ.png`, with unspecified items fixed as recommended designs. Japanese is the source of truth (treat it as canonical). The English version `docs/specs/en/api_orchestrator.md` is an auto-generated mirror (do not edit it directly). **No authentication required.**

The **job management / state management / API hub** container. The single public API that the frontend talks to (**single entry point**. Aggregates REST / SSE control and state. As an exception, only WebRTC video and signaling are connected by the frontend directly to `webrtc_streamer`). `rosbag2_recorder` / `topic_monitor` / `webrtc_streamer` / `dora_runner` are internal services that the orchestrator directs and aggregates.

## Role

- Centralized management of the Run / job lifecycle.
- backend-driven config (settings and schemas provided by the backend; the `tabs` field is v1 legacy — Console v2's tabs are fixed in the frontend and not driven by it).
- A hub that directs each service and aggregates / notifies results.

## Input

- Operations from the frontend (recording Start/Stop, Run registration, Pipeline execution)
- live metrics from `topic_monitor` (SSE)
- job results / logs from `dora_runner` (stage3)

## Constituent components

- **Run Manager** / **Manifest Manager** / **Pipeline Registry** / **Result Aggregator** / **WebSocket・SSE Hub** (**Settings Manager** is a future slot, not implemented; config editing today is handled by `PUT /api/v1/config/recording`)
- A feature-based router structure (`recording` / `topics` / `runs` / `events` / `pipelines` …) is recommended (loosely coupled).

## Public API (`/api/v1`, no auth)

- Recording: `POST /api/v1/record/prepare` (two-phase start — arms the recorder ahead of time. **Creates no DB row**: prepare state is a single in-memory entry, and the response's `run_id` is the one the recorder returned — for a matching keep-alive re-prepare that is the already-armed session's id. A later matching `start` creates the row under that id and takes over; a mismatched or never-consumed prepare is left to the recorder's own auto-disarm), `POST /api/v1/record/start`, `POST /api/v1/record/stop` (doubles as disarm when only an armed session exists), `GET /api/v1/record/status` (proxies to the recorder. **Also serves as lazy reconciliation**: if a run that is live in the DB is reported as finished by the recorder (e.g. the recorder's internal auto-stop on `MAX_RECORD_BYTES`/`MAX_RECORD_SECONDS`), it is settled to completed via the normal stop path, and a live run the recorder does not know about is immediately marked interrupted — without waiting for a restart)
- Run: `GET /api/v1/runs` (cursor paging), `GET /api/v1/runs/{id}` (Console v2 Phase 2 **additively bundles an `episode` summary with each run**. See "Batch / Episode" below)
- Batch / Episode (**Console v2 Phase 2**. Persists Collect's progress and Review's decisions): `POST /api/v1/batches`, `PATCH /api/v1/batches/{id}`, `GET /api/v1/batches?status=&robot=&operator=`, `GET /api/v1/batches/{id}`, `POST /api/v1/episodes`, `PATCH /api/v1/episodes/{id}` (see "Batch / Episode" below)
- Plan vocabulary catalog: `GET /api/v1/plans` / `PUT /api/v1/plans` — the **shared project / task / condition vocabulary** Collect stamps onto batches/episodes (one Projects → Tasks → Conditions JSON, stored in the single-row `plan_catalog` table with a server-stamped `updated_at`). Per-browser local copies let the same physical condition be labeled with different strings, quietly fragmenting the labels, so every terminal is put on ONE vocabulary (2026-07-14 batch-label decision). **NOT the Phase 2.5 Plan model** (no ids/references/target counts; batches keep storing plain strings). Never-set reads `{ projects: null, updated_at: null }` (the client then **seeds** it from its local catalog); an explicitly emptied catalog is `projects: []` + timestamp (never re-seeded). PUT validates the shape (`{ projects: [{ name, tasks: [{ name, conditions: [str] }] }] }`) and replaces the whole catalog, last-writer-wins
- Topic: `GET /api/v1/topics` (list. **The source is a proxy of `topic_monitor`'s `GET /topics` discovery**: `name` / `type` / `publisher_count` / `subscriber_count` / `qos` / `last_seen`), `GET /api/v1/topics/status` (live metrics from the monitor)
- Events: `GET /api/v1/events` (**SSE aggregation**. Contract below)
- Pipeline / Job (stage3. Details in [dora_runner](dora_runner.md)): `GET /api/v1/pipelines`, `POST /api/v1/jobs`, `GET /api/v1/jobs/{id}/status`, `GET /api/v1/jobs/{id}/result`, `POST /api/v1/jobs/{id}/cancel`
- Validation templates: `GET/POST /api/v1/validation/templates`, `POST /api/v1/validation/templates/generate` (generate a draft from a run)
- One-click validation presets: `GET /api/v1/validation/presets` (config-defined presets + their not-yet-validated runs)
- Settings: `GET /api/v1/config` (frontend runtime settings: endpoints / tabs / defaults (including `ros_domain_id`) / stream / schemas). [`GET/POST /api/v1/settings` is **not implemented** (future); `PUT /api/v1/config/recording` below is currently the entry point for config editing]
- Recording config (full edit): `GET /api/v1/config/recording` → `{ config: <RecordingConfig dump>|null, path }`, `PUT /api/v1/config/recording` (body `{ config }`. See "Full editing of recording config" below)
- Signals default display / alert rules (single-file aspect edit): `GET/PUT /api/v1/config/signals` (Review default display; `config/<robot>/signals/default.yaml`; display-only → applies immediately) / `GET/PUT /api/v1/config/alerts` (topic_monitor alert rules; `config/<robot>/monitoring/alerts.yaml`; applies on monitor restart). `GET` → `{ config, raw, path }` (alerts also `warnings`), `PUT` body `{ config }` (form) or `{ raw }` (raw YAML). See "Editing signals / alert rules" below
- Settings catalog: `GET /api/v1/config/options`, `POST /api/v1/config/select` (per-category choices such as validation templates, and the current selection), `GET /api/v1/config/robots/{robot}` (**returns any catalog robot's config read-only** — the parsed content per aspect + a summary. To reference another robot as a template without hot-swapping the live services (Settings). An unknown robot or an invalid path component is `404`)
- System info: `GET /api/v1/system` → `{ cpu: { model, cores }, gpu, cpu_percent, disk, gpu_percent }` (read-only introspection of the host. Always `200`)
  - `cpu` / `gpu`: static information (CPU model name and logical core count from `/proc/cpuinfo`, GPU name from `nvidia-smi`. Each field is `null` when unobtainable)
  - `cpu_percent`: host-wide CPU utilization `[0, 100]` (computed by diffing two snapshots of the aggregated `cpu` line of `/proc/stat` = true busy%, not a load average). `null` on the first sample (no diff baseline yet) or when `/proc/stat` is unreadable
  - `disk`: `{ path, total_bytes, free_bytes }` of the filesystem holding the recording-data directory (`shutil.disk_usage`. Prefers the `data_dir` the app knows; falls back to `/data`. `null` when neither exists)
  - `gpu_percent`: GPU utilization `[0, 100]` (`nvidia-smi --query-gpu=utilization.gpu`). `null` when there is no GPU or `nvidia-smi` is unobtainable (never fabricate a value)
  - `cpu_percent` / `disk` / `gpu_percent` change over time, so they are cached for ~2 seconds (cheap even under SSE-like polling). The `nvidia-smi` probe runs in a worker thread and does not block the event loop
- File serving: `GET /api/v1/files/{path}` — serves a file by a **relative path** from `data_dir` (traversal guard: only under `data_dir`; otherwise / absent is `404`). Used to retrieve `video_check` mp4 previews
- Datasets: `GET /api/v1/datasets` (a list served from the `data/index.jsonl` catalog when present, with **automatic fallback** to a tree scan of `data/<operator>/<task>/<NNN>/dataset.json` when it is absent or corrupt; identical response shape. Reads only under `data_dir`), `GET /api/v1/datasets/{operator}/{task}/{index}` (**detail of an exported dataset**. See "Dataset export" below), `DELETE /api/v1/datasets/{operator}/{task}/{index}` (**delete an exported dataset**. See the same section), `POST /api/v1/datasets/export` (body `{ run_id }`), `POST /api/v1/datasets/export-all` (**bulk** export of completed runs in `recorded/`), `POST /api/v1/datasets/index/rebuild` (regenerate `data/index.jsonl` wholly from the sidecars; returns `{ count }`. The catalog is derived and rebuildable; the sidecars on the tree are canonical — see "Operations" in [config.md](config.md))
- Retention: `GET /api/v1/retention` — the **deletion candidates** by `RETENTION_DAYS` (not exported = a run row still exists, terminal state, started more than N days ago): `{ days, candidates: [{ run_id, started_at, bytes, state, has_episode }], total_bytes }` (computed per request, best-effort sizes). **Advisory only — it never auto-deletes.** Deletion goes only through the existing confirmed `DELETE /api/v1/runs/{id}`. `RETENTION_DAYS<=0` yields an empty candidate set (see "Operations" in [config.md](config.md))
- `GET /healthz` / `GET /readyz` (also returns connectivity of `components: { recorder, monitor, streamer }`)
- `GET /openapi.json` (OpenAPI, published automatically; usable for client generation — the current frontend uses a hand-written typed client)

## Run lifecycle (centrally managed by the orchestrator)

1. `POST /api/v1/record/start` → the orchestrator **assigns a `run_id`** and creates a run in SQLite (`state=created`).
2. Calls the recorder's `POST /record/start` (passing `run_id`). On success, `state=recording`; on failure, the **run row is kept and updated to `state=failed`** (recording the reason. The DB row is not deleted).
3. Immediately after a successful start, fetches the recorder's `GET /record/metadata` and **syncs the finalized topics / type / QoS (including the result of `"all"` expansion) to the run row**. On fetch failure, keeps it `recording`, records the reason in `error`, and retries.
4. `POST /api/v1/record/stop` → recorder stop → re-syncs the final metadata (`message_count` / `bytes` / `ended_at` / topics) and sets `state=completed`. If it completes while still unable to sync, it is set to `state=completed` and the sync failure is left in `error` (subject to reconciliation). After finalizing, it **runs the stop-time quick check off the stop response** and writes `quick_check` onto the run row when it lands (see "Stop-time quick check" below).
5. **Reconciliation on restart**: at startup, reconciles `recording` / `stopping` runs against the recorder's `GET /record/status`, and if no actual entity exists, updates to `state=interrupted`.

- The `run_id` is owned by the orchestrator and passed to the recorder. **SQLite is the single source of truth**; the recorder's `manifest.json` is for auditing.
- A run row's `topics` / type / QoS come from the recorder's metadata (the orchestrator syncs them at the timings above).
- The run state enum follows the shared [config](config.md).
- **operator / task at start**: when empty, `unknown_operator` / `unknown_task` are the defaults (so that the dataset destination `data/<operator>/<task>` is always keyable, eliminating null components).
- **`record_status` SSE**: emits a `record_status` event on each state transition of record start / stop (SSE contract below).
- **`GET /api/v1/runs/{id}` returns RunDetail**: in addition to the run row, it best-effort includes on-disk sidecars — `manifest` (the recorder's `manifest.json`) / `validation` (the `fast_validation` report) / `dataset_stats` (the `dataset_export` report) / `loss` (the `loss_report` report). If a file is absent, it is `null` (returns cleanly even for orphan runs).

## Stop-time quick check (`quick_check` settlement)

At recording stop the orchestrator **settles a two-layer quick check exactly once** and persists it on the run row as `quick_check` (JSON). Division of labor: topic_monitor does always-on live detection, **the orchestrator settles once at stop**, and dora_runner does deep on-demand analysis (it never touches quick_check). **The stop HTTP response is not delayed beyond current behavior**: after the run is finalized (`completed`, etc.) and `record_status` is emitted, the settlement runs **off the stop path (a background task)** and updates the run row with `quick_check` when done. The total budget is ~`4s` (per-downstream-call timeouts, no retry); on timeout it persists **only what completed**, dropping the `available` flags honestly (honest degradation).

- **Layer 0 (no MCAP read, ~ms)** — pulled once at stop:
  - the monitor `GET /metrics` snapshot (per-topic `hz` / `expected_hz` / `rate_shortfall` / `gap_max_ms` / `dds_samples_lost`). `expected_hz` is resolved from `RECORDING_CONFIG` `expected_hz_patterns` (fnmatch, first-match-wins — same rule as the monitor). `dds_samples_lost` is made whole-window by diffing against a **baseline captured at record START** (an in-memory monitor snapshot, keyed by run_id; the baseline pull is best-effort + short-timeout so it never delays start).
  - the monitor `GET /incidents?since_ns=0` (**fetch the whole bounded ring, ≤500**), then keep only the items that **overlap the recording window `[start, stop]`** client-side (`fired_at_ns <= stop` and `cleared_at_ns` at or after `start`, or `null`). Do NOT pass `since_ns=<recording-start>`: the monitor's `since_ns` filter is one-sided (`fired_at_ns >= since_ns OR cleared_at_ns >= since_ns`), so it would **miss an incident that fired before the recording began and is still open** (`cleared_at_ns=null`). Contract: `{ incidents: [ { id, topic, metric, severity: "danger"|"warning", rule_origin: "config"|"derived"|"default", fired_at_ns, cleared_at_ns: int|null, message } ] }`. Timestamps are epoch ns (`time.time_ns`).
  - the recorder's `integrity` (`ok`|`dropped`|`failed`|`unknown`; from the recorder manifest = populated independently of the monitor, so it survives a monitor outage).
  - backstop: the auto-stop note when `MAX_RECORD_SECONDS`/`BYTES` tripped the stop (the recorder writes it into the manifest with an `auto-stopped:` prefix; bundled when present, informational — not a verdict trigger).
  - if the monitor is unreachable / the endpoint `404`s, Layer 0's monitor-derived part degrades to `available: false` honestly (settlement never fails; `integrity` still lands).
- **Layer 1 (MCAP summary-only read, <1s)** — reads ONLY the recorded bag's **summary/statistics section** (per-channel message counts, start/end). It **never scans messages**. Computes per-topic `avg_hz = count / duration` and compares with `expected_hz`; detects missing topics (in config `default_topics` / the recorded set but absent from the bag), empty topics (channel present, count 0), and duration. **If the summary section is absent (unclean stop) it does NOT fall back to a full scan** — it sets `summary_available: false` and treats that as a strong needs_review signal. `available: false` when there is no bag at all.
- **verdict**: `needs_review` if ANY of the following, else `good`. `reasons` lists every **specific** trigger (e.g. `/hsrb/hand_camera avg 8.9Hz < expected 30Hz`); an empty list means `good`.
  - `integrity != "ok"` (including `unknown` / unavailable)
  - a **danger**-severity incident fired during the window (`warning` is recorded but never triggers on its own)
  - any topic's `avg_hz < 0.8 × expected_hz`
  - missing / empty required topics
  - the MCAP summary was unavailable

**Persisted contract (FIXED — the frontend codes against this)**: `quick_check` is stored on the run row (a base `Run` field, so it appears in both the list and the detail) and exposed wherever run details are served. It is `null` until settlement completes (and for runs predating the feature). Shape:

```json
{
  "computed_at": "<iso8601>", "elapsed_ms": 123,
  "layer0": { "available": true, "integrity": "ok|dropped|failed|unknown|null",
    "topics": { "/x": { "hz": 29.7, "expected_hz": 30, "rate_shortfall": 0.01, "gap_max_ms": 40, "dds_samples_lost": 0 } },
    "incidents": [ /* /incidents items overlapping the window */ ], "backstop": "auto-stopped: …|null" },
  "layer1": { "available": true, "summary_available": true,
    "topics": { "/x": { "message_count": 1780, "avg_hz": 29.6, "expected_hz": 30 } },
    "missing_topics": [], "empty_topics": [], "duration_s": 60.1 },
  "verdict": { "quality": "good|needs_review", "reasons": ["…"] }
}
```

- **An episode's default quality derives from `quick_check.verdict.quality`** (this **extends** the existing D-2 "integrity→quality" seam). In `POST /api/v1/episodes`, **omitting** `quality` derives the default from the run's `quick_check.verdict.quality` (`good` | `needs_review`) with `quality_source="quick_check"`; an explicit `quality` is the operator override, stored as-is (`quality_source` then defaults to `operator`). With no `quick_check` to derive from, the default is a conservative `needs_review` (an unsettled run is not vouched as good).
- **Late re-derive on settlement (save-before-settle race)**: **immediately after** settlement writes the run's `quick_check`, if that run already has an episode with `quality_source == "quick_check"`, its `quality` is updated to the settled verdict value (and `updated_at` bumped). This corrects an episode that was saved before settlement and fell back to the conservative `needs_review`. `operator`- / `validator`-sourced quality is **never** touched (it is a human / deep-analysis call). No-op when the run has no episode, and no write when it already matches. A failed re-derive is swallowed independently so the already-persisted `quick_check` is never mislabeled as a settlement failure. There is no existing event/SSE path for episode updates, so no new event plumbing is added (the frontend picks up the settled verdict via the result panel's `GET /runs/{id}` poll).

## Batch / Episode (Console v2 Phase 2)

**Persists** Collect's Batch/Episode progress, task results, and quality decisions in the orchestrator, so Review can show real data independent of the terminal (replacing the earlier in-browser bridge `episodeBridge`). **The existing runs / jobs are untouched.** An episode is a separate table holding a reference to a run; the recording path (record/start → stop → MCAP) is unchanged = no impact on recording safety.

- **Data model** (2 tables added to the orchestrator's existing SQLite):
  - `batches`: `batch_id` (`batch_YYYYMMDD_HHMMSS`) / `robot` / `project` / `task` / `condition` / `operator` / `target_episodes` (default 30) / `status` (`active` | `completed` | `ended_early`) / `ended_reason?` / `created_at` / `ended_at?` / `episodes_recorded` (**monotone counter of recorded episodes. Default 0**) / `batch_seq` (**human-readable batch number per (robot, local date). Nullable**). `project` is a string derived from a Plan (**modelling Plans themselves is deferred to Phase 2.5**).
    - `episodes_recorded` is incremented on each `POST /api/v1/episodes` and **never decremented, even by the run-delete CASCADE** (`episode_count` is the live count and drops on deletion, but Collect's "N / 30"-style displays treat the number of takes as canonical, so this monotone value is used). Added to existing DBs by an additive migration and backfilled with the current episode count.
    - `batch_seq` is **assigned at batch creation (= lazily, at the first recording)**: `1 + MAX(batch_seq)` (over existing batches of the same robot and same local date; the UTC `created_at` is converted to a local date via `date(created_at,'localtime')` for the match). It **resets to 1 each morning by local date, independently per robot**, and becomes the single human-readable number across Collect/Review/Datasets (Collect = "Batch N", Review/Datasets = "MM/DD · #N"; the date is derived from `created_at` = no new column). An empty batch has no row = consumes no number. Numbering is race-safe since read→insert happens in one transaction under the store lock. Added to existing DBs by an additive migration and backfilled per (robot, local date) group in `created_at` ascending order.
  - `episodes`: `episode_id` (`ep_<uuid>`) / `batch_id` / `run_id` (**UNIQUE** = 1 episode = 1 run) / `index_in_batch` / `task_result` (`success` | `failure`) / `failure_reason?` / `quality` (`good` | `needs_review` | `not_usable`) / `quality_source` (`operator` | `quick_check` | `validator`. Default `operator`) / `review_status` (`pending` | `adopted` | `excluded`. Default `pending`) / `created_at` / `updated_at`.
  - FKs are enforced in code (no reliance on SQLite's FK pragma). On `DELETE /api/v1/runs/{id}`, the corresponding episode is **cascade-deleted in code**.
  - `plan_catalog` (single-row table, added 2026-07-14): `id` (`=1` CHECK) / `payload` (the full Projects → Tasks → Conditions JSON) / `updated_at`. Backs `GET/PUT /api/v1/plans` (see "Public API" above).
- **Endpoints**:
  - `POST /api/v1/batches` — start a batch. Body `{ project, task, condition?, operator?, robot?, target_episodes=30 }` → `201` (when `robot` is omitted, it is filled in with the **active robot**). On a same-second collision, `batch_id` is re-assigned with a suffix.
  - `PATCH /api/v1/batches/{id}` — early termination (`status` / `ended_reason`), `condition` changes, and **`target_episodes` changes (1–500; out of range is 422; 2026-07-14)**. **`ended_at` is stamped exactly once when a terminal status (`completed` / `ended_early`) is reached.** Inconsistent transitions are tolerated loosely (no hard rejection). Absent is `404`.
  - `GET /api/v1/batches?status=&robot=&operator=` — batch list (**newest first**). Each element bundles `batch_seq`, `episode_count` (live count), `episodes_recorded` (monotone counter), and a **compact episodes summary** (`index` / `run_id` / `batch_seq` / `task_result` / `quality` / `review_status`) (used to restore the active batch on reload; Collect's counters reference `episodes_recorded`).
  - `GET /api/v1/batches/{id}` — the whole batch + **episodes (full)**. Absent is `404`.
  - `POST /api/v1/episodes` — on Collect Save. Body `{ batch_id, run_id, index_in_batch, task_result, failure_reason?, quality?, quality_source='operator' }` → `201`. Unknown batch / run is `404`; a run that already has an episode is **`409`** (`episode_exists`). **`quality` is optional**: when omitted the default derives from the run's `quick_check.verdict.quality` with `quality_source="quick_check"` (falls back to `needs_review` when there is no `quick_check`); an explicit value is the operator override, stored as-is (see "Stop-time quick check"). **`index_in_batch` is a client hint**: `(batch_id, index_in_batch)` is protected by a UNIQUE constraint, and on a collision (multiple terminals assign the same number) the server re-assigns MAX+1 under the lock and **returns the index it actually saved in the response** (the client adopts the returned value).
  - `PATCH /api/v1/episodes/{id}` — Review's Adopt/Exclude (`review_status`) and quality/result overrides. Absent is `404`. `updated_at` is refreshed on every write.
- **JOIN into runs**: `GET /api/v1/runs` / `GET /api/v1/runs/{id}` **additively bundle** an `episode` summary (`episode_id` / `batch_id` / `batch_seq` / `index_in_batch` / `task_result` / `failure_reason` / `quality` / `review_status`) with each run (`null` when absent). Since `batch_seq` lives on the batch rather than the episode row, the join bulk-resolves `batch_id → batch_seq` and attaches it (so Review/Datasets can show the number without a second round trip). Existing fields are unchanged. The list avoids N+1 via a bulk batch fetch.
- **SSE**: the existing `record_status` / `resync` suffice, so **no new events are added** (Phase 2b if needed).
- **Phase 2.5 TBD**: of the UX spec's Session > Batch > Episode, **Session is not built this time** (to be decided from operational experience). Modelling Plans (Projects/Tasks/Conditions) in the DB and saving edits from Settings are also Phase 2.5.

## Full editing of recording config (`GET/PUT /api/v1/config/recording`)

Edit and persist the entire `RECORDING_CONFIG` from the UI (Settings tab).

- `GET` — returns the live recording config (the current value on `app.state`, reflecting the previous PUT without a restart) and its file path as `{ config, path }` (`config: null` when not loaded).
- `PUT` — body `{ config }`. Type-validates `config` against `RecordingConfig` ([config](config.md)); on failure, **`422`** (returns the violating fields in `details.errors`). On success, **atomically writes the YAML to the `RECORDING_CONFIG` file** (temp + `os.replace`. The write target is always the settings file; the path from the request is not used), and **hot-swaps the in-memory settings**.
- Timing of application: `GET /api/v1/config` and the **`default_topics` (including robot_name, etc.) of the next recording are reflected immediately**. The recorder's QoS / the monitor's expected_hz and allowlist are applied at each service's **next restart** (the UI also indicates this).

## Editing signals / alert rules (`GET/PUT /api/v1/config/{signals,alerts}`)

From Settings > Data quality, edit and persist **two single-file configs of the active robot** that are NOT selectable catalog aspects (recording / stream / validation / validators) (S1' / F2''). Both resolve the active robot's file through the catalog (committed or local), and `PUT` validates with pydantic (**unknown keys rejected**) then atomically writes with the same temp + `os.replace` path as `/recording`. A validation failure is **`422`** (`details.errors`) and leaves the file untouched. The `GET` response is `{ config, raw, path }` (`raw` is the on-disk YAML string = the seed for the Advanced raw-YAML editor; `null` when the file does not exist yet). The `PUT` body is `{ config }` (form) or `{ raw }` (raw YAML — the frontend ships no YAML parser, so the server parses it); the write is always the validated model's canonical YAML.

- **`signals`** (`config/<robot>/signals/default.yaml`): the Review Signals section's default display (`hidden_field_patterns` / `default_topic` / `defaults[{msg_type, fields}]` / `fallback_fields >= 0`). **Display-only → applies immediately** (the Review consumption hook `signalDefaults.ts` re-fetches it; no hot-swap). For a robot with no file yet, `GET` returns the built-in default (hide `header.*`, first 4 leaves) as `config` with `raw: null`.
- **`alerts`** (`config/<robot>/monitoring/alerts.yaml`): the topic_monitor alert rules (`rules[{topic, metric, op, threshold, clear_after_s, cooldown_s, severity}]` + an optional `derived_rules`). `metric` is `hz|bandwidth|gap|late|loss`, `op` is `lt|gt|le|ge` (the same sets the monitor's `AlertRule` accepts, so a valid alerts.yaml round-trips). `metric: loss` is **accepted but flagged in the response `warnings`** (`loss_rate` is always null in the monitor, so it can never fire). **Applies on topic_monitor restart** (alerts.yaml is loaded once at startup — there is no live-reload path; see `topic_monitor/main.py`). The `GET`/`PUT` responses add `warnings: string[]`.

## Job execution (`POST /api/v1/jobs`, proxied to `dora_runner`)

- `dataset_export`: if the target run is unknown, **`404`**; if still recording / stopping (`created` / `recording` / `stopping`), **`409`** (does not export a bag mid-write).
- `fast_validation`: **resolves the `params.template` id (the catalog file stem, e.g. `airoa_hsr`) to a full template via the Config catalog** before forwarding to `dora_runner` (since the dora_runner template store starts empty, a bare id would be a 404). If the id is empty / absent, falls back to the current selection (active). If it is already a dict (full template), passes it through as is.

## Dataset export (`POST /api/v1/datasets/export(-all)`)

An operation that **moves a recording from the canonical staging (`recorded/`) to the dataset tree (`data/<operator>/<task>/<NNN>`)**. Rather than a direct call to `POST /jobs`, the orchestrator waits for the `dataset_export` job to complete and takes care of **the run lifecycle as well**.

- `POST /api/v1/datasets/export` (body `{ run_id }`): if the target is not `completed`, **`409`**; if `recorded/<run_id>` is absent, **`409`** (already exported, etc.). Runs `dataset_export` (the move) to completion, and **deletes the run row only on success** (since it has been moved, also cleans up the `recorded/` directory and sibling files). **The run-keyed report sidecars (`data/report/*/<run_id>`: validation / loss / the video_check mp4 cache) are deliberately kept** — so the dataset detail view can keep showing them after export (an explicit `DELETE /api/v1/runs/{id}` still cleans them up as before). On failure (`502`) / timeout (`504`), the run is left in `recorded/` and in the list.
- `POST /api/v1/datasets/export-all`: exports **all** completed runs whose files remain in `recorded/`. A single failure does not stop the batch; returns `{ exported: [...], failed: [{ run_id, error }], total }`.
- **Labels survive the export (`episode.json`)** — Console v2 Phase 2: since deleting the run row cascades away the episode, the export reads the run's episode (if any) and its batch **before deleting the run row** and writes `episode.json` next to `dataset.json` (atomic tmp+rename write). Contents = `episode_id` / `batch_id` / `batch_seq` / `index_in_batch` / `task_result` / `failure_reason?` / `quality` / `quality_source` / `review_status` + the batch context `batch: { batch_id, batch_seq, project, task, condition, operator, robot }` + `exported_at`. **Without this, failure-labelled data would be exported as unlabelled.** A run with no episode writes no `episode.json` (no empty file either). The single and export-all paths go through the same logic.
- **Root catalog (`data/index.jsonl`)** — a successful export appends one line (`dataset_dir` stored relative to `data_dir` + `schema_version: 1` + the lightweight label subset below), and `DELETE` rewrites the catalog without that row (atomic tmp+rename). It is a derived, rebuildable optimization; the sidecars on the tree are canonical (`GET /api/v1/datasets` prefers the catalog and falls back to a tree scan when it is absent/corrupt; `POST /api/v1/datasets/index/rebuild` regenerates it). The write is best-effort — the export has already moved the MCAP, so a catalog-write failure never fails the export.
- As a result, **exported recordings disappear from the recordings list (the Review tab)** (provenance is saved to `<NNN>/dataset.json`). `GET /api/v1/datasets` lists operator › task › NNN. Each list row bundles a **lightweight subset** of `episode.json` (`task_result` / `failure_reason` / `quality` / `review_status` / `batch_seq` / `index_in_batch` / `batch_id` / `condition`; `null` when absent) for card display (read per row, like `dataset.json`). `batch_id` (globally unique — `batch_seq` resets per robot per local date, so it can't identify a batch on its own) and `condition` (flattened out of episode.json's nested `batch.condition`) let a training-set assembler **exclude whole batches or filter by condition from index.jsonl / the list alone** (2026-07-14 batch-label decision). Pre-existing catalog rows stay `null` until `POST /api/v1/datasets/index/rebuild` heals them from the sidecars.
- **`GET /api/v1/datasets/{operator}/{task}/{index}` returns the post-export equivalent of RunDetail** (DatasetDetail): on top of `dataset.json` (provenance · `files` / `bytes` / `message_count`), it best-effort bundles the moved `session.json` (state / started_at / ended_at), `manifest.json` (topics with name / type / QoS; falls back to the name-only lists in session / dataset.json when absent), **`episode.json` (bundled as the `episode` field; `null` when absent)**, plus the run-keyed reports that survived the export (`validation` / `loss`). The response's `path` (the relative `<operator>/<task>/<index>`) can be used as-is as `params.dataset_dir` when running `video_check` / `loss_report` jobs after export. Path components must be plain single directory names (traversal and the reserved names `recorded`/`report`/`datasets` are `400`); a missing directory or `dataset.json` is `404`.
- **`DELETE /api/v1/datasets/{operator}/{task}/{index}` is the post-export equivalent of `DELETE /runs/{id}`** (`204`): it removes the dataset directory (with its sidecars such as `episode.json`), cleans up the now-empty `<task>` / `<operator>` parent directories, and **also deletes the run-keyed report sidecars (`data/report/*/<run_id>`) deliberately kept at export, since they become orphans here** (they are kept if a run row with the same run_id still exists). The path rules are the same as the detail view (an unsafe component or a reserved name is `400`; a missing directory or `dataset.json` is `404` — a directory without `dataset.json` is never a delete target). A failed removal is `500` (`dataset_delete_failed`).

## SSE event contract (`GET /api/v1/events`)

- Format: `id:` (monotonically increasing integer) / `event:` (kind) / `data:` (JSON).
- Kinds and payloads:
  - `record_status`: `{ run_id, state, message_count, bytes, started_at }` (`started_at` is additive — a page that missed the start transition can still render the elapsed time of an in-progress recording)
  - `metrics`: `topic_monitor`'s periodic snapshot (the output schema of [topic_monitor](topic_monitor.md))
  - `alert`: `{ topic, metric, level, value, threshold }`
  - `job`: `{ job_id, run_id, pipeline, state, progress }`
- Reconnection: the client sends `Last-Event-ID`. The server retains recent events in a ring buffer (default 1000 events / 5 minutes) and resends the unsent portion. If out of range, it sends `event: resync` and the client re-fetches the whole thing.

## Key schemas (excerpt, OpenAPI generation targets / pydantic)

- settings (`GET/POST /api/v1/settings`. **Not implemented, future slot**): `{ defaults: { encoding: "vp8"|"h264", expected_hz: { <pattern>: number } }, alerts: [ { topic, metric, op, threshold, cooldown_s, clear_after_s } ], retention_days: int, max_record_bytes: int }`. The original design intended this to override / supplement `RECORDING_CONFIG` at runtime and take effect from the next recording session, but today `PUT /api/v1/config/recording` (below; atomic write + hot-swap) substitutes for it.
- Validation templates:
  - `GET /api/v1/validation/templates` → `{ items: [ { name, version, required_topics: [ { name, type?: string } ] } ], next_cursor }`
  - `POST /api/v1/validation/templates` body = `{ name, version, required_topics: [ { name, type? } ] }` → `201` same shape
  - `POST /api/v1/validation/templates/generate` body = `{ run_id }` → `{ name, version, required_topics: [ ... ] }` (a draft)
- One-click validation presets:
  - `GET /api/v1/validation/presets` → `{ items: [ { id, name, description, pipeline, params, total, pending, pending_run_ids: [ run_id ] } ] }`. The static fields (`id` / `name` / `description` / `pipeline` / `params`) come from the robot's `validation_presets.yaml` ([config](config.md)). The dynamic fields are computed per request = the completed recordings (runs still in `recorded/`) for which **that pipeline's `report/<pipeline>/<run_id>/summary.json` does not exist yet** (`pending_run_ids`). The UI runs them in one click (`POST /api/v1/jobs` per run). Read-only (does not change state).
- run (`GET /api/v1/runs/{id}` = RunDetail): `{ run_id, state, started_at, ended_at?: string|null, operator?, task?, topics: [ { name, type, qos } ], compression, split?: object|null, error?: { code, message }|null, episode?: object|null, quick_check?: object|null, manifest?: object|null, validation?: object|null, dataset_stats?: object|null, loss?: object|null }` (`episode` is the Phase 2 JOIN. `quick_check` is the settled stop-time quick check [a base `Run` field, so it appears in the list too]. The last 4 come from on-disk sidecars. Each is `null` when absent).
- batch (an element of `GET /api/v1/batches` = BatchSummary): `{ batch_id, robot?, project, task, condition?, operator?, target_episodes, status, ended_reason?, created_at, ended_at?, episodes_recorded, batch_seq?, episode_count, episodes: [ { index, run_id, batch_seq?, task_result, quality, review_status } ] }`. In `GET /api/v1/batches/{id}` (BatchDetail), `episodes` is the full episode array.
- episode (`POST/PATCH /api/v1/episodes`): `{ episode_id, batch_id, run_id, index_in_batch, task_result, failure_reason?, quality, quality_source, review_status, created_at, updated_at }` (`quality` is optional on `POST` = derived from `quick_check` when omitted; the response `quality` / `quality_source` are the settled values).
- job (`GET /api/v1/jobs/{id}/status`): `{ job_id, run_id, pipeline, state, progress, logs_tail }` ([dora_runner](dora_runner.md)).

## Framework / persistence

- **FastAPI + uvicorn** (recommended. Auto-publishes OpenAPI).
- Put heavy processing (validation / conversion, stage3) on an **asynchronous job queue**, decoupled from request/response. Progress is notified via SSE.
- Persistence: **runs / jobs are canonical in SQLite**, the file manifest is for auditing. Avoid accidents where only one side is updated (the settings store is not implemented; recording config is persisted atomically to the config file via `PUT /api/v1/config/recording`).
- Internal service calls use a timeout (default `3s`) + 1 retry. Failures are reflected in `status` / `events` (`503`).

## Errors / conventions / network

- The common API conventions (status codes `400`/`404`/`409`/`422`/`503`/`507`, error format, paging, enums, types / timestamps) follow [config](config.md).
- The bind is `BIND_HOST` (default `0.0.0.0`, **allows LAN exposure**. Assumes a trusted LAN, no auth). CORS is `CORS_ORIGINS` (when exposed on the LAN, add the origin of the relevant host).

## Design points

- **backend-driven**: the orchestrator provides pipeline definitions, form schemas, and runtime settings (the frontend does not hardcode them; only the tab structure became frontend-fixed with Console v2).
- Video (WebRTC) is connected by the frontend directly to `webrtc_streamer`. Everything else is aggregated by the orchestrator.
- Shared configuration is in [config](config.md).
