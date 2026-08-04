<!-- AUTO-GENERATED from docs/specs/ja/api_orchestrator.md. Do not edit by hand — edit the Japanese source and run /sync-docs. -->
# api_orchestrator specification

> Status: design finalized (**v2 = capture store**). Based on `fig_const/apiオーケストラ.png`, with unspecified items fixed as recommended designs. Japanese is the source of truth (treat it as canonical). The English version `docs/specs/en/api_orchestrator.md` is an auto-generated mirror (do not edit it directly). **No authentication required.**

The **job management / state management / API hub** container. The single public API that the frontend talks to (**single entry point**. Aggregates REST / SSE control and state. As an exception, only WebRTC video and signaling are connected by the frontend directly to `webrtc_streamer`). `rosbag2_recorder` / `topic_monitor` / `webrtc_streamer` / `dora_runner` are internal services that the orchestrator directs and aggregates.

**The central change in v2**: the old two tables and two APIs, `runs` and `episodes`, have been consolidated into **a single `captures`**. One capture holds both "the fact of the recording" and "the operator's judgment", so listing, review, deletion, and archive are all addressable by `capture_id`. The conventions for data placement and durability are canonical in [capture_store](capture_store.md); this document describes the **API and state management** layered on top of it.

## Role

- **Centralized management of the capture / job lifecycle**, and maintenance of the capture store's index (`kairos.db`).
- backend-driven config (settings and schemas provided by the backend; the `tabs` field is v1 legacy — Console v2's tabs are fixed in the frontend and not used for display).
- A hub that directs each service and aggregates / notifies results.

## Input

- Operations from the frontend (recording Start/Stop, Review save, deletion, Pipeline execution)
- live metrics from `topic_monitor` (SSE)
- job results / logs from `dora_runner` (stage3)
- On-disk sidecars (`object_manifest.json` / `record.json` / `lifecycle.jsonl`) — **these are canonical for the index**

## Constituent components

- **Capture Store** (the `captures` / `replicas` / `datasets` / `dataset_members` tables and rebuild) / **Pipeline Registry** / **Result Aggregator** / **SSE Hub** / **Reconciler** (**Settings Manager** is a future slot, not implemented; config editing today is handled by `PUT /api/v1/config/recording`)
- A feature-based router structure (`record` / `captures` / `datasets` / `store` / `topics` / `events` / `jobs` …).

## Public API (`/api/v1`, no auth)

- Recording: `POST /api/v1/record/prepare` (two-phase start — arms the recorder ahead of time. **Creates no DB row**: prepare state is a single in-memory entry, and the response's `run_id` / `capture_id` are the ones the recorder returned [for a matching keep-alive re-prepare, those of the already-armed session]. A later matching `start` creates the row under those ids and takes over; a mismatched or never-consumed prepare is left to the recorder's own auto-disarm), `POST /api/v1/record/start`, `POST /api/v1/record/stop` (doubles as disarm when only an armed session exists with no capture), `GET /api/v1/record/status` (proxies to the recorder. **Also serves as lazy reconciliation**: if a capture that is live in the DB is reported as finished by the recorder (e.g. the recorder's internal auto-stop on `MAX_RECORD_BYTES`/`MAX_RECORD_SECONDS`), it is settled to completed via the normal stop path, and a live capture the recorder does not know about is immediately marked interrupted — without waiting for a restart). `prepare` / `start` / `stop` keep the v1 request/response shapes and **add `capture_id`** on top.
- **Capture (the heart of v2; the replacement for runs + episodes)**:
  - `GET /api/v1/captures?state=&review_status=&task=&operator=&robot=&batch=&include_deleted=` (cursor paging. **Tombstones are excluded by default** — the row survives deletion, but the default list is the operator's working set, not an archive of "everything that ever existed". `include_deleted=true` includes them, and an explicit `state=discarded` (or `deleted`) **returns exactly that** [silently returning an empty list for a state that plainly exists is more confusing])
  - `GET /api/v1/captures/{id}` — CaptureDetail (bundles replica state, `digest_state`, sidecars, and reports)
  - `PATCH /api/v1/captures/{id}/review` — a CAS save that requires `base_revision` (see "Saving a review" below)
  - `POST /api/v1/captures/{id}/delete` — body `{ kind: "discard"|"delete", reason? }` (see "Deletion" below)
  - `GET /api/v1/captures/{id}/archive/config` — the roots this deployment permits as archive destinations (when unset, the UI does not surface the archive affordance at all = it never puts up a button that is guaranteed to fail)
  - `POST /api/v1/captures/{id}/archive` — per-capture archive (see "archive" below)
- Batch (**persists Collect's progress**): `POST /api/v1/batches`, `PATCH /api/v1/batches/{id}`, `GET /api/v1/batches?status=&robot=&operator=`, `GET /api/v1/batches/{id}`. **`POST/PATCH /api/v1/episodes` are removed** — the items an episode used to carry now live on the capture row itself, and writes go through `PATCH /api/v1/captures/{id}/review` (see "Batch" below).
- **Store health**: `GET /api/v1/store/health`, `POST /api/v1/store/reconcile`, `POST /api/v1/store/repair` (see "Store health and SUSPECT" below)
- **views**: `POST /api/v1/views/refresh` (regenerates the `views/` symlink tree from committed memberships. The replacement for the old `datasets/export` family)
- Plan vocabulary catalog: `GET /api/v1/plans` / `PUT /api/v1/plans` — the **shared project / task / condition vocabulary** Collect stamps onto batches/episodes (one Projects → Tasks → Conditions JSON, stored in the single-row `plan_catalog` table with a server-stamped `updated_at`). Per-browser local copies let the same physical condition be labeled with different strings, quietly fragmenting the labels, so every terminal is put on ONE vocabulary (2026-07-14 batch-label decision). **NOT the Phase 2.5 Plan model** (no ids/references/target counts; batches keep storing plain strings). Never-set reads `{ projects: null, updated_at: null }` (the client then **seeds** it from its local catalog); an explicitly emptied catalog is `projects: []` + timestamp (never re-seeded). PUT validates the shape (`{ projects: [{ name, tasks: [{ name, conditions: [str] }] }], failure_reasons?: [str] }`) and replaces the whole catalog, last-writer-wins. **`failure_reasons` (2026-08-04)**: the shared vocabulary of reason chips Collect offers on a Failure (edited in Settings > Failure reasons). It rides the same catalog and is returned by GET (never-set is `null` — a catalog written before the field existed also reads back as `null`). **Omitting the field on PUT preserves the stored vocabulary** (an older client cannot wipe it). An explicit `[]` is stored but not adopted by clients (a Failure label requires a reason). **`operators` (2026-08-05)**: the attribution roster (NOT auth) — the header OP picker's choices. Rides the same catalog; omitted on PUT keeps the stored list, and `[]` is a legitimate 'roster not adopted' state (the picker falls back to free text and the recording gate is off)
- Topic: `GET /api/v1/topics` (list. **The source is a proxy of `topic_monitor`'s `GET /topics` discovery**: `name` / `type` / `publisher_count` / `subscriber_count` / `qos` / `last_seen`), `GET /api/v1/topics/status` (live metrics from the monitor)
- Events: `GET /api/v1/events` (**SSE aggregation**. Contract below)
- Pipeline / Job (stage3. Details in [dora_runner](dora_runner.md)): `GET /api/v1/pipelines`, `POST /api/v1/jobs`, `GET /api/v1/jobs/{id}/status`, `GET /api/v1/jobs/{id}/result`, `POST /api/v1/jobs/{id}/cancel`
- Validation templates: `GET/POST /api/v1/validation/templates`, `POST /api/v1/validation/templates/generate` (generate a draft from a capture; body `{ capture_id }`)
- One-click validation presets: `GET /api/v1/validation/presets` (config-defined presets + the list of unvalidated captures)
- Settings: `GET /api/v1/config` (frontend runtime settings: endpoints / tabs / defaults (including `ros_domain_id`) / stream / schemas). [`GET/POST /api/v1/settings` is **not implemented** (future); `PUT /api/v1/config/recording` below is currently the entry point for config editing]
- Recording config (full edit): `GET /api/v1/config/recording` → `{ config: <RecordingConfig dump>|null, path }`, `PUT /api/v1/config/recording` (body `{ config }`. See "Full editing of recording config" below)
- Alert rules (single-file aspect edit): `GET/PUT /api/v1/config/alerts` (topic_monitor alert rules; `config/<robot>/monitoring/alerts.yaml`; applies on monitor restart). `GET` → `{ config, raw, path, warnings }`, `PUT` body `{ config }` (form) or `{ raw }` (raw YAML). See "Editing alert rules" below (the former `GET/PUT /api/v1/config/signals` was removed on 2026-07-15 together with the Review waveform chart)
- Settings catalog: `GET /api/v1/config/options`, `POST /api/v1/config/select` (per-category choices such as validation templates, and the current selection), `GET /api/v1/config/robots/{robot}` (**returns any catalog robot's config read-only** — the parsed content per aspect + a summary. To reference another robot as a template without hot-swapping the live services (Settings). An unknown robot or an invalid path component is `404`)
- System info: `GET /api/v1/system` → `{ cpu: { model, cores }, gpu, cpu_percent, disk, gpu_percent }` (read-only introspection of the host. Always `200`)
  - `cpu` / `gpu`: static information (CPU model name and logical core count from `/proc/cpuinfo`, GPU name from `nvidia-smi`. Each field is `null` when unobtainable)
  - `cpu_percent`: host-wide CPU utilization `[0, 100]` (computed by diffing two snapshots of the aggregated `cpu` line of `/proc/stat` = true busy%, not a load average). `null` on the first sample (no diff baseline yet) or when `/proc/stat` is unreadable
  - `disk`: `{ path, total_bytes, free_bytes }` of the filesystem holding the recording-data directory (`shutil.disk_usage`. Prefers the `data_dir` the app knows; falls back to `/data`. `null` when neither exists)
  - `gpu_percent`: GPU utilization `[0, 100]` (`nvidia-smi --query-gpu=utilization.gpu`). `null` when there is no GPU or `nvidia-smi` is unobtainable (never fabricate a value)
  - `cpu_percent` / `disk` / `gpu_percent` change over time, so they are cached for ~2 seconds (cheap even under SSE-like polling). The `nvidia-smi` probe runs in a worker thread and does not block the event loop
- File serving: `GET /api/v1/files/{path}` — serves a file by a **relative path** from `data_dir` (traversal guard: only under `data_dir`; otherwise / absent is `404`). Used to retrieve `video_check` mp4 previews
- Datasets (**logical**; physical moves are gone entirely): `GET /api/v1/datasets`, `POST /api/v1/datasets` (body `{ name, operator?, task? }`), `GET /api/v1/datasets/{dataset_id}` (with members), `DELETE /api/v1/datasets/{dataset_id}`, `POST /api/v1/datasets/{dataset_id}/members` (body `{ capture_id }`), `DELETE /api/v1/datasets/{dataset_id}/members/{membership_id}` (see "Datasets (logical)" below)
- Import (external bags): `POST /api/v1/imports` (body `{ source_path, move? }` → `202 { import_id }`. The source is **a path on the server** [a bag is several GB and is not something to upload through a browser]. Validation is synchronous, the copy is asynchronous), `GET /api/v1/imports`, `GET /api/v1/imports/{id}`
- Transfer (split deployments): `GET /api/v1/transfer/status`, `POST /api/v1/transfer/pull` (see "Transfer (split deployments)" below)
- Retention: `GET /api/v1/retention` — returns the **deletion candidates** by `RETENTION_DAYS` (`{ days, candidates: [{ capture_id, run_id, started_at, bytes, state, review_status }], total_bytes }`. Computed per request, best-effort sizes). **Advisory only — it never auto-deletes.** Deletion goes only through the confirmed `POST /api/v1/captures/{id}/delete`. `RETENTION_DAYS<=0` yields an empty candidate set. **v2 changes what counts as a candidate**: the old definition — "a row exists = not yet exported" — stopped meaning anything once rows no longer disappear, so it is gone entirely. A candidate is now "**a capture that no dataset references and that has sat at `review_status` `pending` or `excluded` for more than N days**" (details in "Operations" in [config.md](config.md))
- `GET /healthz` / `GET /readyz` (also returns connectivity of `components: { recorder, monitor, streamer }`)
- `GET /openapi.json` (OpenAPI, published automatically; usable for client generation — the current frontend uses a hand-written typed client)

### Removed APIs (no compatibility aliases)

This is an alpha, so no compatibility layer is provided. **None of them does anything**, but the code returned is not uniform: a route that vanished entirely gives `404`, while **one that merely collides on path with a route that survived gives `405`** (for example `POST /api/v1/datasets/export` matches `GET|DELETE /api/v1/datasets/{dataset_id}` with `dataset_id="export"`, and since no POST is registered it becomes Method Not Allowed). **What matters is not which code comes back, but that the old route no longer does anything.**

| Removed | Replacement |
|---|---|
| `GET/DELETE /api/v1/runs`, `GET /api/v1/runs/{id}`, `DELETE /api/v1/runs/{id}` | `GET /api/v1/captures`, `GET /api/v1/captures/{id}`, `POST /api/v1/captures/{id}/delete` |
| `POST/PATCH /api/v1/episodes`, `PATCH /api/v1/episodes/{id}` | `PATCH /api/v1/captures/{id}/review` |
| `GET/DELETE /api/v1/datasets/{operator}/{task}/{index}` | `GET/DELETE /api/v1/datasets/{dataset_id}` |
| `POST /api/v1/datasets/export`, `POST /api/v1/datasets/export-all` (**`405`**) | `POST /api/v1/datasets/{id}/members` + `POST /api/v1/views/refresh` |
| `POST /api/v1/datasets/index/rebuild` | Not needed (`data/index.jsonl` is gone entirely; the index is handled by the rebuild at startup) |

## Capture lifecycle (centrally managed by the orchestrator)

1. `POST /api/v1/record/start` → the orchestrator **assigns a `run_id` (the display name)** and calls the recorder's `POST /record/start`. **The `capture_id` is issued by the recorder** and returned in the response.
2. Creates the `captures` row under the returned `capture_id` (`state=recording`). If the recorder rejects, **when it names a capture, a `failed` row under that id is returned**. When it names none, the error is propagated as-is and the failed-start sidecar the recorder wrote (`objects/<capture_id>.failed.json`) is turned into a row by the next rebuild.
3. Immediately after a successful start, fetches the recorder's `GET /record/metadata` and **syncs the finalized topics / type / QoS (including the result of `"all"` expansion) to the capture row**. On fetch failure, keeps it `recording`, records the reason in `error`, and retries.
4. `POST /api/v1/record/stop` → recorder stop → re-syncs the final metadata (`message_count` / `bytes` / `ended_at` / topics) and sets `state=completed`. Once settled, it **runs the stop-time quick check off the stop response** (below) and then **enqueues the digest job** (see "digest job" below).

   **A stop must STOP.** Idempotent does not mean "do nothing when no DB row claims to be recording": a row can be missing or in a different state (a start whose row never committed, a crash, a reconcile that raced), so when there is no row, `stop` **asks the recorder what it is ACTUALLY doing**:
   - recorder not recording → the idempotent no-op as before (return the most recent capture; 404 if no capture has ever existed)
   - recorder recording a capture we **have a row for** → adopt that row and run the normal stop + finalize path over it
   - recorder recording with **no row** (an orphan) → nothing to finalize, but stop it anyway

   Both the adopt and the orphan-stop branches log at WARNING (reaching them means the DB and the recorder had already drifted). Without this, a stop that stopped nothing answers `200`, the console walks on to labelling a take that is still recording, and the `MAX_RECORD_SECONDS` auto-stop is the only thing that ever ends it.
5. **Reconciliation on restart**: at startup, reconciles `recording` / `stopping` captures against the recorder's `GET /record/status`, and if no actual entity exists, updates to `state=interrupted`.

- **The `capture_id` is owned by the recorder**; the orchestrator receives it and indexes it (`run_id` is the display name the orchestrator assigns).
- **The sidecars are canonical, the DB is an index.** `kairos.db` can be rebuilt in full from `object_manifest.json` / `record.json` / `lifecycle.jsonl` ([capture_store](capture_store.md) §8.2). v1's "SQLite is the single source of truth, the manifest is for auditing" is **withdrawn**.
- A capture row's `topics` / type / QoS come from the recorder's metadata (the orchestrator syncs them at the timings above).
- The capture state enum follows [capture_store](capture_store.md) §8.1 and the shared [config](config.md).
- **operator / task at start**: when empty, `unknown_operator` / `unknown_task` are the defaults. They are no longer path components in v2, but nulls are eliminated so that the `views/` tree and the list's grouping stay keyable at all times. The **reserved name** check (`objects` / `views` / `.trash` / `.incoming` / `report` / `catalog` / `lifecycle.jsonl` / `instance.json` / `kairos.db`) happens at **dataset creation**, where those strings do become path components (the `name` / `operator` / `task` of `POST /api/v1/datasets` → `400 reserved_name`).
- **`record_status` SSE**: emits a `record_status` event on each state transition of record start / stop (SSE contract below).
- **`GET /api/v1/captures/{id}` returns CaptureDetail**: in addition to the capture row, it best-effort bundles the on-disk sidecars and reports — `manifest` (`object_manifest.json`) / `record` (`record.json`) / `validation` (the `fast_validation` report) / `loss` (the `loss_report` report). If a file is absent, it is `null`.

## Saving a review (`PATCH /api/v1/captures/{id}/review`)

The replacement for the old `POST/PATCH /api/v1/episodes`. **Sidecar-first + CAS** (the convention is in [capture_store](capture_store.md) §4.1):

1. If `base_revision` does not match the current `captures.review_revision`, **`409 review_conflict`**. The client reloads and re-applies — **it never merges**.
2. Atomically writes `record.json` with `revision = base_revision + 1`. On failure → **`500 review_sidecar_write_failed`, and the DB is untouched** (nothing was saved, so the same `base_revision` can simply be retried).
3. CAS-updates the DB. `rowcount=0` → **`409`**. The sidecar that was written is not rolled back.

- body: `{ base_revision, task_result?, failure_reason?, quality?, quality_source?, review_status?, batch_id?, index_in_batch? }`.
- **This is where the old `POST /episodes` side effects moved to**: the monotone increment of `batches.episodes_recorded` and the auto-pull trigger fire on **the first review save for that capture**.
- Saving against a tombstoned or absent capture is `409` (`capture_deleting` / `capture_deleted` / `capture_not_present`).

## Deletion (`POST /api/v1/captures/{id}/delete`)

body `{ kind: "discard"|"delete", reason? }`. **`discard` requires `reason`** (`400 reason_required`) — discarding is irreversible, and that one ledger line is the only explanation left behind afterwards.

The procedure, the tombstone, and the reaper conventions are in [capture_store](capture_store.md) §7. The points that matter from the API's side:

- **The response returns at the moment the capture has moved into `.trash` and the tombstone is committed.** The physical removal (the reaper) runs in the background afterwards. That split is the point: the operator's action is made durable by the tombstone, and if the reaper fails, what is left is "a replica still visibly `trashed`", not "a request hung in `unlink`".
- `409 capture_busy` — a job holds the lease (the response names the owner and the expiry time).
- `409` — while `recording` / `stopping`.
- `400` — still referenced from `dataset_members` (remove the membership first).
- `503 delete_unavailable` — `objects/` and `.trash/` are on different filesystems. **The routes stay registered and return this response per request** (rather than vanishing silently, they refuse and state the reason; the same reason also appears in `delete_unavailable_reason` of `GET /api/v1/store/health`). archive entails deleting the source too, so it is treated the same way.
- Deletion also reclaims `report/<pipeline>/<capture_id>/`. **The row is not removed** (the tombstone), so "where did it go" can always be answered later.

## archive (`POST /api/v1/captures/{id}/archive`)

Evacuates a capture to external storage, one capture at a time. It keeps the order **copy → sha256 verify → ledger (`capture_archived`) → delete the source** (via trash).

- Not one byte is copied before the destination has been validated against `KAIROS_ARCHIVE_ROOTS` — this endpoint **deletes the source at the end**, which makes an unconstrained destination string the most dangerous input in the system.
- **Rejecting an overlap is a check separate from the allow-list** (passing the former is no evidence about the latter). What is checked is the **resolved write target** (`<destination>/<capture_id>`), not the permitted root itself — so **permitting a root that contains `data_dir` is not itself forbidden** (`KAIROS_ARCHIVE_ROOTS=/data` is the kind of setting an operator would plausibly choose, and on the allow-list alone the path of copying onto itself and then deleting the source would go through). Both sides are resolved with `realpath` (preventing disguise via symlinks) and containment is checked **in both directions**. A violation is `400 destination_inside_data_dir`.
- **A non-empty destination is `409 destination_not_empty`** (rejected down in the copy primitive).
- The ledger's `capture_archived` event carries **per-file `{path, size, sha256}`**. Once the source is gone the manifest goes with it, so without this all you could say is "N bytes went to /mnt/nas", and years later you could not answer "is that copy still intact?".
- **A capture that is a dataset member is refused for archive too** (the same `400` as delete). It would leave the `views/` symlink dangling, so remove the membership first. The one exemption is the §6.1 dataset-archive runner itself (below), and it covers **only the membership in that run's own dataset**.

## dataset archive (`POST /api/v1/datasets/{id}/archive`, §6.1)

The dataset's terminal transition. The capture archive lifted to a dataset: the destination validation (the allow-list plus the two-way overlap check against the resolved dataset_dir) and the removal order (copy → verify → ledger → delete the source) are identical to the per-capture case.

- `POST /api/v1/datasets/{dataset_id}/archive` — body `{ destination?, path?, mode?, reason? }` → **`202`** (doubles as start and resume). `mode` is `move` (the default; deletes the sources; demands exclusive members) or `copy` (seal only; the sources untouched; shared members legal — the standard for a combined set). `path` is a **relative path of the operator's choosing** under the root (its last component is the dataset's folder; the UI prefills it with the views shape). Absolute or empty is `400 invalid_destination`, an escape (`..` and the like) is `400 destination_not_allowed` via realpath re-validation of the final directory, and a collision with an existing export is `409 destination_not_empty`. When omitted, the server composes `<destination>/<operator>/<task>/<name>` (the components sanitised the same way as views). copy also runs under `delete_unavailable` (it deletes nothing).
  - Refusals before starting: `404 dataset_not_found` / `409 dataset_archived` (terminal) / `409 dataset_empty` / `409 dataset_member_shared` (members that also belong to another dataset, **all of them enumerated in `details.conflicts`**) / `409 dataset_not_archivable` (busy / absent members, **all of them enumerated in `details.blockers`, each with its own reason** — a deliberate aggregation, so that N problems are not thrown back one at a time and the operator sent around the loop N times) / `409 destination_not_empty` / the `400` family is the same as the capture archive (`archive_not_configured` / `invalid_destination` / `destination_not_allowed` / `destination_inside_data_dir`) / `503 delete_unavailable` and `ledger_unwritable`.
  - Resume: with status `archiving` and no run in flight, a re-POST resumes idempotently from where it left off. The destination / mode are **either omitted or identical to the record** (otherwise `409 archive_destination_mismatch` / `409 archive_mode_mismatch`). While a run is in flight, `409 archive_in_progress`.
- `GET /api/v1/datasets/{dataset_id}/archive` — progress. The durable fields (status / destination / archive_started_at / archived_at) come from the rows and survive a restart; `running` / `current_capture_id` / `current_bytes` / `error` are process memory and are honestly reset. **`archiving` with `running: false` is "resumable"**, and the UI renders it as Resume. It is a separate endpoint rather than an extension of `GET /datasets/{id}` so that 1-second polling does not thrash the detail cache.
- Adding or removing a member on a dataset whose status ≠ `active` is `409 dataset_not_active`, and `DELETE /datasets/{id}` is `409 dataset_archiving` / `409 dataset_archived` — **the archived row is the queryable cache of the migration log and is never deletable**. In the reverse direction, an archived capture (`409 capture_archived`) and a member of a non-active dataset (`409 capture_archiving`) cannot enter a new dataset.

## Transfer (split deployments, `/api/v1/transfer/*`)

In a deployment where the robot and the recording PC are separate hosts, this is the path that draws a completed capture over to the recording PC side. The rsync itself is done by the importer sidecar (`deploy/sync/`, present only in `compose/recording.yaml` and bound to 127.0.0.1), and the orchestrator is its only caller.

- `GET /api/v1/transfer/status` → `{ available, auto_pull_on_save }`. `available` is the reachability of the importer's `/healthz`, and that **is the frontend's split-deployment signal as it stands** (in a single-host deployment there is no importer, so it is false).
- `POST /api/v1/transfer/pull` → `202`. The **`capture_id` in the body is optional**:
  - **Given** → `{"capture_id": …}` is forwarded to the importer and only that capture is pulled.
  - **Omitted** → it means "pull every completed capture", and it is forwarded to the importer **as an explicit `{"all": true}`**. **An empty body must never be sent** — the importer is specified to reject an empty body with `400`, and that is deliberate design. It **structurally forbids** a request that merely dropped one key from being demoted from a targeted pull into a sweep of the entire robot; a sweep only ever happens when it was explicitly asked for.
- **Completion is not reported through this API** (the ack is fire-and-forget). What the frontend watches is the capture's **replica state**, which turns `present_unverified` the moment the reconciler adopts the arrived directory. v1's `bag_local` boolean has been removed — it could only say "here / not here", and thus **could not distinguish a copy that never arrived from a copy that was deleted on purpose**.
- The importer stages into `.incoming/<capture_id>` and, once complete, moves it into `objects/` with `os.replace`. A capture visible in `objects/` is therefore never a partial copy ([capture_store](capture_store.md) §2).
- **auto-pull**: when `transfer.auto_pull_on_save` is enabled, the orchestrator issues one such pull after **the first review save for that capture**. It is disabled by default, and nothing is transferred without an explicit opt-in.

## Store health and SUSPECT (`/api/v1/store/*`)

A set of endpoints for surfacing the **two worst states that never appear in the capture list**:

- a manifest the rebuild could not read — that capture has no row ([capture_store](capture_store.md) §8.2 rule 4 forbids treating it as "not there"), so there is no way for it to show up in the list.
- a reconciler pass that refused to apply because a large number of copies vanished at once — the catalog **looks fine** in that moment, while the disk is not.

- `GET /api/v1/store/health` → `{ instance_id, state: "ok"|"suspect", suspect_reason?, suspect_at?, delete_available, delete_unavailable_reason?, rebuilt_at?, rebuild_summary?, corrupt: [{capture_id?, path, reason}], corrupt_source: "rebuild"|"reconcile", corrupt_observed_at?, warnings: [], last_reconcile_at?, last_reconcile? }`.
  - There is one corrupt list, and **the latest scan that ran to completion wins**. A pass that could not observe (marker mismatch, unreadable ledger) **keeps the list it holds rather than clearing it** (never report "everything was clean" for what you could not see). A pass blocked by the threshold still reports what it did see.
- `POST /api/v1/store/reconcile` — runs one reconcile pass right now and returns the result (the same pass as the background loop. It is exposed so an operator who has just fixed a mount does not have to wait out the interval, and so tests can drive it deterministically instead of sleeping).
- `POST /api/v1/store/repair` — the operator's approval that clears SUSPECT. **When the volume marker cannot be read it is refused with `409 volume_unidentified`** — the latch exists precisely because "the whole volume went away" and "the files went away" are indistinguishable, so an approval that cannot name which volume it is approving is not an approval. After clearing, one pass is run with `approved=True` (re-running the normal pass would re-latch on the same threshold, making Repair a button that does nothing).

## digest job

After stop, computes per-file sha256 and seals `object_manifest.json` **exactly once, in a single atomic write** (`files` / `manifest_digest` / `digest_state=complete`). On completion, `replicas.state → present_verified`.

- It starts only after confirming **both** of two things: (a) `captures.state` is terminal, (b) the recorder is not holding that capture (it is not in `live_capture_ids`). **Never promote to `present_verified` before verification.**
- While it runs, it appears in the UI as `digest_state=pending` (never conflate "verified" with "being verified").
- After a crash the reconciler re-enqueues the pending ones (partial results are thrown away and the work starts over from the beginning).
- It takes the lease before touching `objects/<id>`, and re-checks `captures.state` under the lock immediately before the final write (skipping if it is `delete_pending`/`discarded`/`deleted`).

## Stop-time quick check (`quick_check` settlement)

At recording stop the orchestrator **settles a two-layer quick check exactly once** and persists it on the capture row as `quick_check` (JSON). Division of labor: topic_monitor does always-on live detection, **the orchestrator settles once at stop**, and dora_runner does deep after-the-fact analysis (it never touches quick_check). **The stop HTTP response is not delayed beyond current behavior**: after the capture is settled into a terminal state (`completed`, etc.) and `record_status` is emitted, the settlement runs **off the stop path (a background task)** and updates the capture row with `quick_check` when done. The total budget is ~`4s` (per-downstream-call timeouts, no retry); on timeout it persists **only what completed**, dropping the `available` flags honestly (honest degradation).

- **Layer 0 (no MCAP read, ~ms)** — pulled once at stop:
  - the monitor `GET /metrics` snapshot (per-topic `hz` / `expected_hz` / `rate_shortfall` / `gap_max_ms` / `dds_samples_lost`). `expected_hz` is resolved from `RECORDING_CONFIG` `expected_hz_patterns` (fnmatch, first-match-wins — the same rule as the monitor). `dds_samples_lost` is made whole-window by diffing against a **baseline captured at record START** (an in-memory monitor snapshot, keyed by `capture_id`; the baseline pull is best-effort + short-timeout so it never delays start).
  - the monitor `GET /incidents?since_ns=0` (**fetch the whole ring, ≤500**), then keep only the items that **overlap the recording window `[start, stop]`** client-side (`fired_at_ns <= stop` and `cleared_at_ns` at or after `start`, or `null`). Do NOT pass `since_ns=<recording-start>`: the monitor's `since_ns` filter is one-sided (`fired_at_ns >= since_ns OR cleared_at_ns >= since_ns`), so it would **miss an incident that fired before the recording began and is still open** (`cleared_at_ns=null`). Contract: `{ incidents: [ { id, topic, metric, severity: "danger"|"warning", rule_origin: "config"|"derived"|"default", fired_at_ns, cleared_at_ns: int|null, message } ] }`. Timestamps are epoch ns (`time.time_ns`).
  - the recorder's `integrity` (`ok`|`dropped`|`failed`|`unknown`; from the recorder manifest = populated independently of the monitor, so it survives a monitor outage).
  - backstop: the auto-stop note when `MAX_RECORD_SECONDS`/`BYTES` tripped the stop (the recorder writes it into the manifest with an `auto-stopped:` prefix; bundled when present, informational — not a verdict trigger).
  - if the monitor is unreachable / the endpoint `404`s, Layer 0's monitor-derived part degrades to `available: false` honestly (the settlement never fails; `integrity` still lands independently).
- **Layer 1 (MCAP summary-only read, <1s)** — reads ONLY the recorded bag's **summary/statistics section** (per-channel message counts, start/end). It **never scans messages**. Computes per-topic `avg_hz = count / duration` and compares with `expected_hz`; detects missing topics (in config `default_topics` / the recorded set but absent from the bag), empty topics (channel present, count 0), and duration. **If the summary section is absent (unclean stop) it does NOT fall back to a full scan** — it sets `summary_available: false` and treats that as a strong needs_review signal. `available: false` when there is no bag at all.
- **verdict**: `needs_review` if ANY of the following, else `good`. `reasons` lists every **specific** trigger (e.g. `/hsrb/hand_camera avg 8.9Hz < expected 30Hz`); `good` is an empty list.
  - `integrity != "ok"` (including `unknown` / unavailable)
  - a **danger**-severity incident fired within the window (`warning` is recorded but never triggers on its own)
  - any topic's `avg_hz < 0.8 × expected_hz`
  - missing / empty required topics
  - the summary was unavailable

**Persisted contract (FIXED — the frontend codes against this)**: `quick_check` is stored on the capture row (a base `Capture` field, so it appears in both the list and the detail) and exposed on every path that returns a capture. It is `null` until settlement completes. Shape:

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

- **The default quality derives from `quick_check.verdict.quality`** (this **extends** the existing D-2 "integrity→quality" seam). **Omitting** `quality` in `PATCH /api/v1/captures/{id}/review` takes the capture's `quick_check.verdict.quality` (`good` | `needs_review`) as the default and stamps `quality_source="quick_check"`. An explicit `quality` is the operator's override, stored as-is (`quality_source` then defaults to `operator`). With no `quick_check`, the conservative `needs_review` applies (an unsettled capture is not vouched as good).
- **Late re-derive after settlement (the save-before-settle race)**: **immediately after** settlement writes `quick_check` onto the capture, if that capture has already been reviewed (`review_revision > 0`) and `quality_source == "quick_check"`, its `quality` is updated to the settled verdict value. This corrects a review that was saved before settlement completed and was left on the conservative `needs_review` fallback. `operator`- / `validator`-sourced quality is **never** touched (that is a human / deep-analysis call).
  - **This correction also goes through the normal §4.1 path and advances `revision`.** A client receiving a `409` as a result is the correct behavior: it states the plain fact that "the review you hold is no longer the latest". If the operator edited during settlement it gets a `409`, and **that person's judgment wins** (the correction is abandoned).
  - A failed re-derive is swallowed independently, so an already-settled `quick_check` is never misreported as a settlement failure. No dedicated SSE path is added (the frontend picks up the settled result via the result panel's `GET /api/v1/captures/{id}` poll).

## Batch

**Persists** Collect's Batch progress in the orchestrator so Review can show real data independent of the terminal (the in-browser bridge `episodeBridge` has been removed).

**The `episodes` table is gone in v2.** The fields an episode carried (`task_result` / `failure_reason` / `quality` / `quality_source` / `review_status` / `batch_id` / `index_in_batch`) now live on **the capture row itself**, and writes go through `PATCH /api/v1/captures/{id}/review`. The UNIQUE constraint expressing 1 run = 1 episode also became structurally unnecessary, now that one capture plays both roles.

- **Data model**:
  - `batches`: `batch_id` (`batch_YYYYMMDD_HHMMSS`) / `robot` / `project` / `task` / `condition` / `operator` / `target_episodes` (default 30) / `status` (`active` | `completed` | `ended_early`) / `ended_reason?` / `created_at` / `ended_at?` / `episodes_recorded` (**monotone counter of recorded episodes. Default 0**) / `batch_seq` (**human-readable batch number per (robot, local date). Nullable**). `project` is a string derived from a Plan (**modelling Plans themselves is deferred to Phase 2.5**).
    - `episodes_recorded` is incremented on **the first review save for that capture** and **never decremented, not even when the capture is deleted** (`episode_count` is the live count and drops on deletion, but Collect's "N / 30"-style displays treat the number of takes as canonical, so this monotone value is used).
  - **Batch rows are outside the scope of rebuild** ([capture_store](capture_store.md) §8.2 rule 6). `project` / `robot` / `condition` / `target_episodes` / `batch_seq` / `status` / `episodes_recorded` are written into no sidecar, so throwing away `kairos.db` **loses** them (a known loss). `batch_id` / `index_in_batch` on the capture side are restored from `record.json`, so "which capture was which number in which batch" survives.
    - `batch_seq` is **assigned at batch creation (= lazily, at the first recording)**: `1 + MAX(batch_seq)` (over existing batches of the same robot and same local date; the UTC `created_at` is converted to a local date via `date(created_at,'localtime')` for the match). It **resets to 1 each morning by local date, independently per robot**, and becomes the single human-readable number across Collect/Review/Datasets (Collect = "Batch N", Review/Datasets = "MM/DD · #N"; the date is derived from `created_at` = no new column). An empty batch has no row = consumes no number. Numbering is race-safe since read→insert happens in one transaction under the store lock. Added to existing DBs by an additive migration and backfilled per (robot, local date) group in `created_at` ascending order.
  - The review fields live on the `captures` row: `batch_id` / `index_in_batch` / `task_result` (`success` | `failure`) / `failure_reason?` / `quality` (`good` | `needs_review` | `not_usable`) / `quality_source` (`operator` | `quick_check` | `validator`) / `review_status` (`pending` | `adopted` | `excluded`. Default `pending`) / `review_revision` (for CAS. Not yet reviewed = 0). **`record.json` is canonical**, and the DB is its cache ([capture_store](capture_store.md) §4).
  - FKs are enforced in code (no reliance on SQLite's FK pragma). Deleting a capture **does not remove the row** (the tombstone), so there is nothing corresponding to v1's CASCADE delete.
  - `plan_catalog` (single-row table, added 2026-07-14): `id` (`=1` CHECK) / `payload` (the full Projects → Tasks → Conditions JSON) / `updated_at`. Backs `GET/PUT /api/v1/plans` (see "Public API" above).
- **Endpoints**:
  - `POST /api/v1/batches` — start a batch. Body `{ project, task, condition?, operator?, robot?, target_episodes=30 }` → `201` (when `robot` is omitted, it is filled in with the **active robot**). On a same-second collision, `batch_id` is re-assigned with a suffix.
  - `PATCH /api/v1/batches/{id}` — early termination (`status` / `ended_reason`), `condition` changes, and **`target_episodes` changes (1–500; out of range is 422; 2026-07-14)**. **`ended_at` is stamped exactly once when a terminal status (`completed` / `ended_early`) is reached.** Inconsistent transitions are tolerated loosely (no hard rejection). Absent is `404`.
  - `GET /api/v1/batches?status=&robot=&operator=` — batch list (**newest first**). Each element bundles `batch_seq`, `episode_count` (live count), `episodes_recorded` (monotone counter), and a **compact summary** (`index` / `capture_id` / `run_id` / `batch_seq` / `task_result` / `quality` / `review_status`) (used to restore the active batch on reload; Collect's counters reference `episodes_recorded`).
  - `GET /api/v1/batches/{id}` — the whole batch + **`captures` (the full capture array)**. Absent is `404`.
  - **Saving goes through `PATCH /api/v1/captures/{id}/review`** (Collect's Save). `batch_id` / `index_in_batch` / `task_result` / `failure_reason` / `quality` / `review_status` ride on it. **`index_in_batch` is a client hint**: on a collision (multiple terminals assigning the same number) the server re-assigns under the lock and **returns the value it actually saved in the response** (the client adopts the returned value).
- **Bundling into captures**: since `batch_seq` lives on the batch rather than the capture row, listing bulk-resolves `batch_id → batch_seq` and attaches it (so Review/Datasets can show the number without a second round trip). The list avoids N+1 via a bulk batch fetch.
- **SSE**: the existing `record_status` / `resync` suffice, so **no new events are added**.
- **Phase 2.5 TBD**: of the UX spec's Session > Batch > Episode, **Session is not built this time** (to be decided from operational experience). Modelling Plans (Projects/Tasks/Conditions) in the DB and saving edits from Settings are also Phase 2.5.

## Full editing of recording config (`GET/PUT /api/v1/config/recording`)

Edit and persist the entire `RECORDING_CONFIG` from the UI (Settings tab).

- `GET` — returns the live recording config (the current value on `app.state`, reflecting the previous PUT without a restart) and its file path as `{ config, path }` (`config: null` when not loaded).
- `PUT` — body `{ config }`. Type-validates `config` against `RecordingConfig` ([config](config.md)); on failure, **`422`** (returns the violating fields in `details.errors`). On success, **atomically writes the YAML to the `RECORDING_CONFIG` file** (temp + `os.replace`. The write target is always the settings file; the path from the request is not used), and **hot-swaps the in-memory settings**.
- Timing of application: `GET /api/v1/config` and the **`default_topics` (including robot_name, etc.) of the next recording are reflected immediately**. The recorder's QoS / the monitor's expected_hz and allowlist are applied at each service's **next restart** (the UI also indicates this).

## Editing alert rules (`GET/PUT /api/v1/config/alerts`)

From Settings > Data quality, edit and persist a **single-file config of the active robot** that is NOT a selectable catalog aspect (recording / stream / validation / validators) (F2''). It resolves the active robot's file through the catalog (committed or local), and `PUT` validates with pydantic (**unknown keys rejected**) then atomically writes with the same temp + `os.replace` path as `/recording`. A validation failure is **`422`** (`details.errors`) and leaves the file untouched. The `GET` response is `{ config, raw, path }` (`raw` is the on-disk YAML string = the seed for the Advanced raw-YAML editor; `null` when the file does not exist yet). The `PUT` body is `{ config }` (form) or `{ raw }` (raw YAML — the frontend ships no YAML parser, so the server parses it); the write is always the validated model's canonical YAML. (The former `signals` aspect — the Review waveform chart's default display — was removed on 2026-07-15, endpoints and `config/<robot>/signals/` included, together with that chart.)

- **`alerts`** (`config/<robot>/monitoring/alerts.yaml`): the topic_monitor alert rules (`rules[{topic, metric, op, threshold, clear_after_s, cooldown_s, severity}]` + an optional `derived_rules`). `metric` is `hz|bandwidth|gap|late|loss`, `op` is `lt|gt|le|ge` (the same sets the monitor's `AlertRule` accepts, so a valid alerts.yaml round-trips). `metric: loss` is **accepted but flagged in the response `warnings`** (`loss_rate` is always null in the monitor, so it can never fire). **Applies on topic_monitor restart** (alerts.yaml is loaded once at startup — there is no live-reload path; see `topic_monitor/main.py`). The `GET`/`PUT` responses add `warnings: string[]`.

## Job execution (`POST /api/v1/jobs`, proxied to `dora_runner`)

- **Jobs are keyed by `capture_id`** (§10.5). The `POST /api/v1/jobs` body is `{ capture_id, pipeline, params? }`. The `dataset_dir` param is gone (source resolution is `objects/<capture_id>` and nothing else).
- **The capture lease is taken here** ([capture_store](capture_store.md) §7.1): dora_runner is deliberately lease-unaware (it only reads the capture and writes a report; it knows nothing about deletion), so the orchestrator — which holds both the catalog and the delete path — takes it on dora_runner's behalf. Acquired at submission, **renewed on every status / result poll observation (renew-on-poll)**, and released owner-scoped once a terminal state is observed. While the lease is alive, discard / delete return `409 capture_busy`.
  - **The TTL only guarantees "for as long as someone is watching".** A running job is protected because the UI polls its status, but **a queued job is not** — a job left waiting with nobody polling loses its lease, and delete wins. That job later fails cleanly against a directory that has moved to `.trash` (a late but clean termination, not corruption). State this guarantee precisely, docstrings included.
  - Submitting against a tombstoned capture is `409` (`capture_deleting` / `capture_deleted`).
- If the target capture is unknown, **`404`**; if it is still recording / stopping, **`409`** (never let a bag be read mid-write).
- `GET /jobs/{id}/result` returns **`artifacts` normalised to data-root-relative paths**: dora_runner reports absolute container paths (e.g. `/data/report/<pipeline>/<capture_id>/plot.png`), and the orchestrator relativises those under `data_dir`, so each artifact is directly fetchable via `GET /api/v1/files/{path}`. This is the **visualisation channel that lets a plugin surface images (plots etc.) with zero UI edits** ([dora_plugins.md §2.5](dora_plugins.md)). Absolute paths outside `data_dir` and already-relative paths pass through unchanged.
- `fast_validation`: **resolves the `params.template` id (the catalog file stem, e.g. `airoa_hsr`) to a full template via the Config catalog** before forwarding to `dora_runner` (since the dora_runner template store starts empty, a bare id would be a 404). If the id is empty / absent, falls back to the current selection (active). If it is already a dict (full template), passes it through as is.

## Datasets (logical)

**Physical moves and copies of the bytes are gone entirely.** A dataset is nothing but **DB rows + ledger events**; the recorded bytes never budge from `objects/<capture_id>`. That structurally eliminates the state "the power died mid-move", and putting one capture into several datasets, or taking it out of a dataset and back into the recordings list, are both done without touching a byte.

- `POST /api/v1/datasets` — body `{ name, operator?, task? }` → `201`. `dataset_id` is a UUIDv7. `dataset_created` in the ledger.
- `PATCH /api/v1/datasets/{dataset_id}` — body `{ name?, operator?, task? }` → `200`. **Label editing** (the same patch semantics as the review save: omitted = kept, explicit null = cleared. `name` cannot be cleared, `400 invalid_name`). `dataset_updated` in the ledger (**the complete post-change label set**), and `views/` follows with a regeneration. Non-active is `409 dataset_not_active`. A no-op PATCH writes nothing to the ledger.
- `GET /api/v1/datasets` — the list (with `member_count`). `GET /api/v1/datasets/{dataset_id}` — with members (`membership_id` / `capture_id` / `display_index`).
- `POST /api/v1/datasets/{dataset_id}/members` — body `{ capture_id }` → `201`. The server assigns `display_index` and **never reuses a gap for a different recording** (the high-water mark can be recovered from the ledger) — but **re-adding the same capture takes its former number back from the ledger** (so that re-registering after an accidental remove does not read as a new take). `dataset_member_added` in the ledger.
- `DELETE /api/v1/datasets/{dataset_id}/members/{membership_id}` → `204`. `dataset_member_removed` in the ledger.
- `DELETE /api/v1/datasets/{dataset_id}` → `204`. `dataset_deleted` in the ledger. **The capture's bytes are not touched.**
- **The stable ids are `dataset_id` / `membership_id`** (names are editable, `display_index` is for display). The UI's URL state is held with those two as well.
- **A capture that is a member is refused for both delete and archive** (`400`). It would leave the `views/` symlink dangling, so remove the membership first.
- **The terminal transition** is "dataset archive" above (§6.1): `datasets.status` walks `active → archiving → archived` in one direction, and a non-active dataset's member set is frozen.
- **Regenerating `views/`** (`POST /api/v1/views/refresh`): rebuilds the `views/<operator>/<task>/<dataset_name>/<NNN> -> objects/<capture_id>` symlink tree from **committed `dataset_members` rows of `status='active'` datasets only** (archiving/archived vanish from the tree as a declaration — §6.1). It is done atomically by swapping the symlink via a generation directory + `os.replace`, so **there is never a moment when `views` does not exist, nor a moment when a half-built tree can be read**. There is exactly one owner, the orchestrator (dora_runner only asks). The tree is a derived artifact that can be wiped and regenerated; the DB rows and the ledger are canonical.

## SSE event contract (`GET /api/v1/events`)

- Format: `id:` (monotonically increasing integer) / `event:` (kind) / `data:` (JSON).
- Kinds and payloads:
  - `record_status`: `{ capture_id, run_id, state, message_count, bytes, started_at }` (`started_at` is additive — a page that missed the start transition can still render the elapsed time of an in-progress recording). **Receivers must drop a rewind within the same capture**: one capture's state only moves `created → armed → recording → stopping → terminal`, so a lower state arriving late is old information, not news. A rewind to `recording` makes the console believe a recording it is not driving is running, and it puts the takeover card over an already-stopped take. A differing `capture_id` is not a rewind (a new capture legitimately goes `recording` right after the previous one reached a terminal state).
  - `metrics`: `topic_monitor`'s periodic snapshot (the output schema of [topic_monitor](topic_monitor.md))
  - `alert`: `{ topic, metric, level, value, threshold }`
  - `job`: `{ job_id, capture_id, pipeline, state, progress }`
- Reconnection: the client sends `Last-Event-ID`. The server retains recent events in a ring buffer (default 1000 events / 5 minutes) and resends the unsent portion. If out of range, it sends `event: resync` and the client re-fetches the whole thing.

## Key schemas (excerpt, OpenAPI generation targets / pydantic)

- settings (`GET/POST /api/v1/settings`. **Not implemented, future slot**): `{ defaults: { encoding: "vp8"|"h264", expected_hz: { <pattern>: number } }, alerts: [ { topic, metric, op, threshold, cooldown_s, clear_after_s } ], retention_days: int, max_record_bytes: int }`. The original design intended this to override / supplement `RECORDING_CONFIG` at runtime and take effect from the next recording session, but today `PUT /api/v1/config/recording` (below; atomic write + hot-swap) substitutes for it.
- Validation templates:
  - `GET /api/v1/validation/templates` → `{ items: [ { name, version, required_topics: [ { name, type?: string } ] } ], next_cursor }`
  - `POST /api/v1/validation/templates` body = `{ name, version, required_topics: [ { name, type? } ] }` → `201` same shape
  - `POST /api/v1/validation/templates/generate` body = `{ capture_id }` → `{ name, version, required_topics: [ ... ] }` (a draft)
- One-click validation presets:
  - `GET /api/v1/validation/presets` → `{ items: [ { id, name, description, pipeline, params, total, pending, pending_capture_ids: [ capture_id ] } ] }`. The static fields (`id` / `name` / `description` / `pipeline` / `params`) come from the robot's `validation_presets.yaml` ([config](config.md)). The dynamic fields are computed per request = those captures in a terminal state for which **that pipeline's `report/<pipeline>/<capture_id>/summary.json` does not exist yet** (`pending_capture_ids`). The UI runs them in one click (`POST /api/v1/jobs` per capture). Read-only (does not change state).
- capture (`GET /api/v1/captures/{id}` = CaptureDetail): `{ capture_id, run_id?, source_instance_id?, state, started_at?, ended_at?, operator?, task?, robot?, topics: [ { name, type, qos } ], compression, split?, error?: { code, message }|null, message_count?, bytes?, quick_check?: object|null, task_result?, failure_reason?, quality?, quality_source?, review_status, review_revision, batch_id?, index_in_batch?, deleted_at?, delete_kind?, delete_reason?, archived_at?, archive_destination?, lease_owner?, lease_expires_at?, replica?: Replica|null, digest_state, memberships: [ { membership_id, dataset_id, dataset_name?, display_index } ], manifest?, record?, validation?, loss? }`.
  - `replica`: `{ instance_id, state, path?, manifest_digest?, verified_at?, updated_at? }`. The `state` vocabulary is in [capture_store](capture_store.md) §8.1. **`null` means "this machine does not have a copy yet"** (a normal state in a split deployment), not an error.
  - `digest_state` (`pending` | `complete`) is not a column but a value derived from the local replica row (`present_verified` ⇔ `complete`).
  - The last four come from on-disk sidecars / reports, and are `null` when absent.
- batch (an element of `GET /api/v1/batches` = BatchSummary): `{ batch_id, robot?, project, task, condition?, operator?, target_episodes, status, ended_reason?, created_at, ended_at?, episodes_recorded, batch_seq?, episode_count, episodes: [ { index, capture_id, run_id?, batch_seq?, task_result, quality, review_status } ] }`. In `GET /api/v1/batches/{id}` (BatchDetail), `captures` is the full capture array.
- review save (`PATCH /api/v1/captures/{id}/review`): body `{ base_revision, task_result?, failure_reason?, quality?, quality_source?, review_status?, batch_id?, index_in_batch? }` → the updated Capture.
- store health (`GET /api/v1/store/health` = StoreHealth): see "Store health and SUSPECT" above.
- job (`GET /api/v1/jobs/{id}/status`): `{ job_id, capture_id, pipeline, state, progress, logs_tail }` ([dora_runner](dora_runner.md)).

## Framework / persistence

- **FastAPI + uvicorn** (recommended. Auto-publishes OpenAPI).
- Put heavy processing (validation / conversion, stage3) on an **asynchronous job queue**, decoupled from request/response. Progress is notified via SSE.
- Persistence: **a capture is canonical in its on-disk sidecars** (`object_manifest.json` / `record.json` / `lifecycle.jsonl`), and **SQLite is an index that can be rebuilt in full from them**. At startup it rebuilds when the DB is missing, the schema version differs, or `KAIROS_REBUILD` is set ([capture_store](capture_store.md) §8.2). `jobs` is volatile and out of scope for rebuild; `validation_templates` / `plan_catalog` are duplicated into sidecars under `catalog/*.json` and restored from there. The settings store is not implemented (recording config is persisted atomically to the config file via `PUT /api/v1/config/recording`).
- **Startup sequence**: identity (`instance.json`. A corrupt one fails startup — a new id orphans every replica) → invariants (the same-filesystem check across `objects`/`.trash`/`.incoming`, reserving `.ledger-slack`) → rebuild if needed (**abort startup if the ledger cannot be read**. The ledger outranks the manifests, so rebuilding without it resurrects every capture the operator discarded) → **delete-resume (every time, whether or not a rebuild ran)**.
- Internal service calls use a timeout (default `3s`) + 1 retry. Failures are reflected in `status` / `events` (`503`).

## Errors / conventions / network

- The common API conventions (status codes `400`/`404`/`409`/`422`/`503`/`507`, error format, paging, enums, types / timestamps) follow [config](config.md).
- The bind is `BIND_HOST` (default `0.0.0.0`, **allows LAN exposure**. Assumes a trusted LAN, no auth). CORS is `CORS_ORIGINS` (when exposed on the LAN, add the origin of the relevant host).

## Design points

- **backend-driven**: the orchestrator provides pipeline definitions, form schemas, and runtime settings (the frontend does not hardcode them; only the tab structure became frontend-fixed with Console v2).
- Video (WebRTC) is connected by the frontend directly to `webrtc_streamer`. Everything else is aggregated by the orchestrator.
- Shared configuration is in [config](config.md).
