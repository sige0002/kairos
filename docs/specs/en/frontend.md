<!-- Mirror of docs/specs/ja/frontend.md (the Japanese file is canonical). Keep this file in sync by hand — the sync-docs skill was retired. -->
# frontend specification

> Status: design settled (**v2 = Console v2**, merged 2026-07-13). Fully reorganized from v1 (feature tabs) into **role tabs**. The Japanese version is canonical (treat it as the source of truth). This English file is a manually maintained mirror (keep it in sync with the Japanese). **No authentication.**

A backend-driven, lightweight Web UI (Vite + React + TypeScript). Tabs are organized not by technical function (v1: Live / Graph / Probe / Recordings / Validation / Datasets / Config) but by **"whose job is it"** — 6 tabs: **Collect / Review / Datasets / Validation / Monitor / Settings**.

## Roles

| Tab | Whose job | What it does |
|---|---|---|
| Collect | Operator | Run recordings, judge immediately, improve |
| Review | ML engineer | Judge recording quality and labels, ship to datasets |
| Datasets | ML engineer | Catalog of exported datasets, (future) dataset building |
| Validation | Robot engineer | Run pipelines, standardize validation |
| Monitor | Robot engineer | Communication, signal and system diagnostics |
| Settings | Robot engineer | Robot configuration, plans, and their scope of effect |

Core concepts: **recording quality and task result are separate axes** (a failed task ≠ bad data; failures are kept, labeled, and used for training). Recording proceeds in a **Batch > Episode** hierarchy persisted by the orchestrator ([api_orchestrator.md](api_orchestrator.md) "Batch / Episode"; the Session level is **TBD**: Phase 2.5).

## Implementation

- Base: **Vite + React + TypeScript**.
- State: **Zustand** (UI state) + **TanStack Query** (server state; SSE events are folded into the cache). Routing is URL-query based (`?tab=<id>`).
- Charts: unified on **uPlot** (axis ticks, crosshair, series overlay, zoom). UI: **Tailwind CSS** (components are hand-rolled).
- Live video: **WebRTC** (connects to `webrtc_streamer`'s `/stream/offer`).
- Tests: **Vitest + Testing Library**.

## Inputs

- WebRTC video (`webrtc_streamer`; by default same-origin via `/webrtc`, reverse-proxied by the frontend's nginx; override with `WEBRTC_PUBLIC_URL`)
- Numeric-field sample streams (`topic_probe`; same-origin via `/probe`; used by Monitor's Signals view)
- REST / SSE (`api_orchestrator` `/api/v1`)

## Tabs and navigation

- **The 6 tabs are fixed in the frontend** (`V2_TABS`). v1's "backend `tabs` registry-driven" mechanism is **retired** — the `tabs` field of `GET /api/v1/config` remains for compatibility but v2 does not use it for display or ordering.
- **All legacy tab ids redirect** to preserve deep links: `live`→`collect`, `graph`/`probe`→`monitor`, `runs`→`review`, `dataset`→`datasets`, `config`→`settings`.
- Every tab is URL-addressable (`?tab=<id>`). **`?tab=<id>&solo=1` renders only that tab with no tab bar** (a ↗ button per tab opens its solo page in a new window — the multi-window way to see several charts at once).
- **Header (shared by all tabs)**: the 6 tabs, a **ROS_DOMAIN_ID badge**, a **connection chip** (SSE connection state), and an **OP chip** — click to set the operator name (persisted in localStorage; sent as `operator` on every subsequent `/record/start`).

## Screens

### Collect — run recordings and judge immediately

- **Context bar**: Robot (real selection; same robot catalog as Settings) / Project · Task · Condition (pickers fed by Plans, plus Custom free input) / **Batch number** / episode progress "n / target".
  - The batch number is the **server-issued `batch_seq`** (per robot × local date, restarting from 1 each morning). Before a batch exists, show a **prediction** — "next #N · assigned on first recording" (today's max seq + 1) — which settles to the server value on the first recording. There is no "planned batch count" denominator (it has no real referent).
- **Batch / Episode progress is server-persisted**: the batch is created lazily on the first recording (`POST /api/v1/batches`). An empty batch has no row and consumes no number. Reloads / tab switches restore via `GET /api/v1/batches?status=active`.
- **Batch menu** semantics (End early / Reset **never delete recordings**):
  - Pause / Resume (currently local only; server-side is **TBD**: Phase 2.5) / End batch early (`status=ended_early` + reason) / Reset (a **complete no-op** for an empty batch; with recordings it closes the current batch and the next recording starts a new number) / Change condition (PATCH) / Report issue.
- **Recording controls**: Start / Stop. Arming gate (waits for subscription establishment; "N matched · N missing" note), failed-start banner (**plain wording leads, the raw code follows** — `already_recording` etc. are mapped to operator language), **recorder cache/drop detection banner** (`dropped_messages` + a cache-setting hint, gated to the current run). **Keyboard**: `R`=Start / `S`·`Space`=Stop / `Esc`=Cancel arming / `?`=shortcut list (disabled while an input field is focused; button labels show a hint such as `· R`). On each phase transition, focus moves to the next primary action (never falls to the body).
- **Recording state is server-truth** (5s polling of `GET /record/status`; HCD fix 2026-07-14): if a recording this browser did not start / has lost is running, a **RECORDING IN PROGRESS card** (run / elapsed / size / operator / topics, a `Stop & save` behind a confirm modal, `Open in Monitor →`) appears instead of READY. The Recorder row of SYSTEM STATUS comes from the same query = the "READY yet 409" contradiction cannot arise structurally. A take recovered by stopping appears under "Unsaved-take recovery" below. Record-topic resolution matches v1 (selected / configured / all; the selection is shared with Monitor's Rec column, a "REC N topics" chip links to Monitor; Start is disabled on an empty selection).
- **Saving an episode**: Stop → a real event gate (resolve the stop API → read integrity; the fixed timer is retired, a failed stop stays in SAVING with `Retry stop`) → the result panel. **Success is the default selection**, and a clean success is a single `Save — success` action (Enter works). Failure branches from ✕ with a mandatory reason. **Quality is auto-derived from the real integrity** (clean → `Good · auto`, drop/failed → `Needs review · auto` + the real drop count), and can be overridden freely from `change` with the three choices (good / needs_review / not_usable) — **`quality_source='operator'` only on an override, `'quick_check'` when not overridden** (never faking provenance). Saving goes through `POST /api/v1/episodes`, and **only after the server confirms 201** a receipt `Saved — Episode n of Batch m · {operator}` (a transient ring on the strip chip). Discard is a **real delete** behind a confirm modal (`DELETE /api/v1/runs/{id}`).
- **Unsaved-take recovery**: even if you leave between Stop and Save, on reload an amber banner "Unsaved take from {time} — {N} MB, {duration}" (`Label it` / `Discard` / `Later`) lets you recover it (it detects the most recent run that is completed and has no episode).
- The "n / target" count is the **monotone counter `episodes_recorded`** (what was recorded is the truth; deletions in Review do not decrease it; if it diverges from the quality tallies, a footnote says so honestly).
- **Cameras**: WebRTC previews. Panes can be added/removed (max 4). The main pane has resolution presets; sub panes are force-capped to low resolution (240/360p). **Latency / fps live in an overlay chip at the top-right inside the preview video** (per-tile measured values, threshold colors; never placed outside the video). Pre-connect placeholders state the reason (an empty tile must not read as a failure).
- **Quick check** (the post-stop quality summary) is a display shell only — **real evaluation is TBD (Phase 3)**. The settled design: a "settlement of monitoring statistics accumulated during recording", two layers — Layer 0 = statistics the monitor/recorder already hold during recording (counts, drops, gaps, expected_hz ratio; final at stop), Layer 1 = read only the MCAP summary section (O(index)). Must complete in **≤5 s with zero transfer even in the split deployment**.
- **Advice** is a single fixed mock (hold still ~1s). **Generation logic is TBD (Phase 3)**. Only the approach is settled: live advice consumes the orchestrator's aggregated SSE metrics; deep advice consumes the transferred MCAP (dora never touches DDS).
- Fits **without scrolling** from 1920×1080 down to 1366×768 (compact density).

### Review — judge quality and labels, export

- List + detail of completed recordings. Each row joins run and episode (`GET /api/v1/runs`) and shows **Batch "MM/DD · #N" / Task result / Quality / lane** chips. Filterable by operator etc. **The list follows the cursor to the end** (it does not silently cut off at 200), and the header shows real-data tally chips (`n ready · n needs check · n excluded` / `n success · n failure`). The displayed number is the **persistent `index_in_batch`** (not renumbered on deletion). The decision buttons (Mark OK / Exclude / Export CTA) are a **fixed bar outside the scroll**.
- **Exception-review model**: episodes with good quality (or operator-confirmed) are **READY** with zero extra clicks. Only **NEEDS CHECK** (quality not good and still pending) forms the work queue — resolved with "Mark OK — include" or Exclude. Default order is NEEDS CHECK → READY → EXCLUDED. Decisions go through `PATCH /api/v1/episodes/{id}` (`review_status`).
- **Export lives only on this tab** (one function, one place): "**Export ready (n)…**" bulk-exports all READY completed recordings (a **move**; see [api_orchestrator.md](api_orchestrator.md) dataset export). The "Include task-failed (labeled)" toggle defaults to ON (failure data is not excluded wholesale). A **pipeline strip** (Recorded → Reviewed → Ready → Export → In dataset) shows the current position and next action, with an inline Export CTA right after READY is reached.
- **Deletion is two-step**: Exclude = "Excluded — kept on disk" (non-destructive, label only) → only excluded items offer "Delete from disk…" (confirms run_id, size, irreversibility; bulk "Delete excluded (n)…" runs sequentially and reports failures honestly). EXCLUDED items and confirmed exceptions offer "↩ Return to review" back to pending (reversible).
- **Detail inspection**: manifest / validation / loss_report table / on-demand mp4 "Video check" player / JSON blocks. `fast_validation` can be run from the detail.
- The **MCAP transfer column / "transfer to recording PC" button** for the split deployment is implemented but **disabled behind a flag** (off by default; never shown in the single-PC deployment). **TBD**: a signal by which the orchestrator self-reports split mode (from referencing a remote recorder), plus the transfer job (the recorder's read-only serving endpoints `GET /runs` · `GET /runs/{id}/files/{name}` + orchestrator pull / checksum / DB registration / SSE progress). Settled: transfer is **manual pull only** (no auto-transfer scheduler) and **transfer and validation are separate buttons** (no auto-chain).

### Datasets — catalog of exported datasets

- **Catalog only**. No export operations here (only a pointer: "Recordings are reviewed and exported in Review → Go to Review"). v1's judgment-free bulk dump (Export all) is **deliberately retired** in favor of the Review path.
- List: the operator › task › NNN tree from `GET /api/v1/datasets`. Each card shows **episode label chips** (from `episode.json`: batch / task result / quality / review status). **Exports without labels render as muted "legacy (pre-label)"** (nothing is fabricated).
- Detail = DatasetDetail (metadata / topic list / loss report / mp4 Video check / dataset.json, episode.json and other JSON). Loss / video jobs read the exported MCAP via `params.dataset_dir`.
- **Delete** (confirm modal, same UX as deleting a recording) calls `DELETE /api/v1/datasets/{op}/{task}/{index}`.
- **Build** (conversion to LeRobot v3 etc.) and **Recipe-based dataset construction are unimplemented (TBD: Phase 3)** — the UI shows muted shells that do not pretend to be working controls.

### Validation — pipeline execution, standardized

Keeps v1's functionality as-is; only the layout is v2.

- **Pipeline-agnostic**: pick a pipeline (all enabled from `GET /api/v1/pipelines`) → **grouped target selection**: `Runs (before export)` (the primary path) + `Datasets (exported)` (re-validation of already-exported data, run via `params.dataset_dir`; only dataset-capable pipelines are enabled, the rest are disabled with an "applies to runs" note; empty states are shown honestly per group) → **parameter form** (auto-generated from `schemas.pipeline_forms[<id>]`) → run (`POST /api/v1/jobs`). Results are drawn by a **generic renderer** that renders `summary.json` shape-independently (PASS/FAIL badge, message, metrics key-value tree, artifacts, raw JSON). **Adding a plugin requires no changes to this tab** ([dora_plugins.md §2.5](dora_plugins.md)).
- Only the bundled `fast_validation` has a dedicated checklist against the template's required topics. Results can be downloaded as CSV.
- **Batch execution**: "All completed runs" submits the selected pipeline to every completed recording (`POST /api/v1/jobs` per run), with a per-run progress list (live state; PASS/FAIL on completion).
- **One-click validation presets**: preset buttons from `GET /api/v1/validation/presets` (`pipeline` + fixed `params`), bulk-run against **not-yet-validated completed recordings** (`pending_run_ids`). Shows "N pending"; disabled as "up to date" at zero. Defined in per-robot config `config/<robot>/validation_presets.yaml` ([config.md](config.md)).
- The `dataset_export` pipeline remains as the programmatic equivalent of Review's Export (the same **move**). The tab states "Validation only — export stays in Review." explicitly (Export's one-function-one-place is unchanged).
- Lifecycle chips (Experimental → Standard promotion) are **visual only (TBD: substance later)**.

### Monitor — communication, signal and system diagnostics

The merge target of v1's Graph / Probe / Live health panels. The sub-nav (§11 order) is **Overview / Topics / Signals / System / Events / Logs**. All six sub-views are built on real data (unmeasurable values show "—"; an empty chart / list explains why). The default is Overview.

- **Context strip**: REC · run_id · elapsed while recording, STANDBY otherwise (real, from `record_status`).
- **Overview view** (the diagnostic landing, default): record context, a topic-health tally (`ok`/`warning`/`danger`/`inactive` counts + the topics needing attention by name → click to chart them in Topics), an active-incident summary (the real alert buffer), a compact `GET /api/v1/system` snapshot, and jump links to Topics/Signals.
- **Topics view**:
  - **Add / remove chart panels (max 4)**. Per panel: metric (**Frequency / Bandwidth / Max gap / Rate vs expected**) and topic overlay (max 6). Time window (30s / 1m / 5m) and **Freeze charts / Live** (formerly Pause) are global — the freeze is charts-only (it states `Charts frozen · table still live.`; the table deliberately stays live). Since the window accumulates from when it was opened, while the accumulation is shorter than the window it honestly shows `{window} window (n so far)`. Chart height **follows the measured slot** (a root fix for the bug where a fixed height was clipped by an overflow-hidden parent, hiding the low value range). **Recording REC / STOP markers** overlay every panel. Frequency shows the expected_hz reference line. **Latency / loss are not on the menu** — a non-intrusive monitor cannot measure them (per-run loss is provided by Review's post-hoc analysis).
  - **Topics table**: all discovered topics + live metrics (Hz / bandwidth / gap, status dot `inactive`/`danger`/`warning`/`ok`/`unknown`, shortfall badge with reason tooltip on threshold breach; shortfall is observed, not true loss). **Rec checkbox column** = the topic selection for the next recording (not a mid-recording change). Configured topics are pre-checked; reseeded from config on robot switch; independent of chart series selection.
- **Signals view** (v1 Probe, ported): a generic plotter for **numeric fields** from `topic_probe`, overlaid per (topic, field). Pick topic → numeric field (arrays expand to `[0..N]`), **overlay fields across different topics**. Sample-rate selection (1/5/10/30 Hz, default 10), window, Pause. **Decoding is isolated in the `topic_probe` container and never affects recording or monitoring** ([topic_probe.md](topic_probe.md)).
- **System view** (full page): host measurements (CPU% / GPU% / disk usage · `GET /api/v1/system`; unavailable values show "—") + ROS_DOMAIN_ID / service endpoints (`GET /api/v1/config`) + **component health**. Health is expressed only from signals the browser can honestly observe: orchestrator = the live SSE pipe, monitor = the `bridge` event. Per-container recorder / streamer readiness is checked by the orchestrator's **server-side `/readyz`** (for the Docker health checks) and is not exposed at the browser origin, and the UI says so (`/readyz` is not proxied on the same origin, so it is not fetched). A compact **System card** is embedded in the Overview / Topics right rail.
- **Events**: SSE `alert`s **collapsed to one row per incident (topic × metric)** — while firing, `firing · since {t}` updates the current value in place; on clearing it flips to `cleared · {t}` (muted); a re-fire shows `×n`. The **Events card** (Overview / Topics right rail) shows the collapsed rows; the **Events view** (full page) adds a topic substring + state (firing/cleared/all) filter and a note (history is session-local, since Monitor was opened). Topics with no config rule are also picked up by the monitor's default DANGER incident (persisting ~10s) = **the table's DANGER and Events do not contradict** ([topic_monitor.md](topic_monitor.md)).
- **Logs view**: a session-local timeline of received SSE lifecycle events (record_status / alert / job) with type chips + a text filter (a bounded ~500-entry ring buffer). Honestly labelled "since this page opened / full logs live in `docker compose logs`". Metrics are not logged (high-frequency noise).

### Settings — robot configuration and plans

- **Robots**: robot list (committed `config/<robot>/` and gitignored `config/local/<robot>/`) and selection (`POST /api/v1/config/select` hot-swaps recording / stream; recorder QoS / monitor expected_hz apply on next restart — the UI says so; **activating while recording shows a "Stop and switch?" confirm modal**). **A non-active robot's config is viewable read-only** (`GET /api/v1/config/robots/{robot}`; a "Read-only — {robot} is not the active robot." banner + disabled JSON readable as a template). **Aspect** (recording / stream / validation / validators) option selection. The recording config is editable and persisted as JSON (`PUT /api/v1/config/recording`; **inline validation**: invalid JSON disables Save with a plain error; saving while recording shows an "applies from the next recording" info banner). Creating a new robot is not possible — `+ Add robot` opens not a disappearing toast but a **persistent explainer that shows the next step** (create a `config/<robot>/` folder + reference an existing robot as a template). The bottom of the rail retires the sourceless version display for the **active robot's real values**.
- **Projects & tasks (Plans)**: edit Project / Task / Condition definitions. Shared store with Collect's pickers, reflected immediately (currently localStorage; **TBD**: server persistence in Phase 2.5).
- **Recording**: the active robot's recording config shown **form-first** (`GET /api/v1/config/recording`: compression / start gate [`start_paused`] / cache [`max_cache_size_mb`] and a default_topics table [expected Hz, QoS-override badge]). The raw JSON editor is demoted to an "Advanced" disclosure (collapsed by default, `PUT /api/v1/config/recording`).
- **Data quality** (read-only): from the `GET /api/v1/config/robots/{robot}` aspect content — expected-Hz reference rates + the monitor's warn/danger thresholds (`monitor.warn_shortfall`/`danger_shortfall`) + the active validation template's required topics. The explicit threshold alert rules live in the API-unexposed `config/<robot>/monitoring/alerts.yaml`, stated plainly (the response's `robot` = robot directory id, so the path actually exists).
- **Validation**: the validation / validators aspect selection (`POST /api/v1/config/select`) + a one-click preset list (`GET /api/v1/validation/presets`, pending counts). Execution links to the Validation tab (one function, one place).
- **System** (read-only): deployment facts (ROS_DOMAIN_ID, endpoints, data dir/storage, component health). The version row is omitted because there is no honest client-side version source; RMW/DDS is not exposed by the API, so only a note is shown.
- **Honest placeholders**: **Dataset profiles** (awaiting the Phase 3 recipe model) and **Users & permissions** (nothing to manage in the single-LAN, no-auth scope) render a rationale-only placeholder — no dead controls.

## Data flow (SSE × cache)

- Subscribe to the single SSE stream (`GET /api/v1/events`) and fold each event type into the TanStack Query cache; components subscribe to keys and re-render.
- SSE disconnection is surfaced in the UI (the header connection chip) with automatic reconnection (`Last-Event-ID`).

## Outputs (APIs called)

- Recording: `POST /api/v1/record/start` / `stop`
- Batch / Episode: `POST /api/v1/batches`, `PATCH /api/v1/batches/{id}`, `GET /api/v1/batches?status=active`, `POST /api/v1/episodes`, `PATCH /api/v1/episodes/{id}`
- Runs: `GET /api/v1/runs` (with the episode JOIN), `GET /api/v1/runs/{id}` (RunDetail), `DELETE /api/v1/runs/{id}`
- Topics / system: `GET /api/v1/topics/status`, `GET /api/v1/events` (SSE), `GET /api/v1/system`
- Config: `GET /api/v1/config`, `GET/PUT /api/v1/config/recording`, `GET /api/v1/config/options`, `POST /api/v1/config/select`
- Files: `GET /api/v1/files/{path}` (video_check mp4)
- Datasets: `GET /api/v1/datasets`, `GET/DELETE /api/v1/datasets/{op}/{task}/{index}`, `POST /api/v1/datasets/export(-all)` (the UI entry point is Review's Export ready)
- Jobs: `GET /api/v1/pipelines`, `POST /api/v1/jobs` (`fast_validation` / `loss_report` / `video_check`; with `params.dataset_dir` after export), `GET/POST /api/v1/validation/templates`, `GET /api/v1/validation/presets`
- Probes (the only two direct, non-orchestrator connections): `/probe` (topics / fields / SSE sample streams), `/webrtc` (offer / ICE)

## Design principles

- **Honesty principle**: never display what cannot be measured (no fake latency / loss; shortfall ≠ loss). Never fabricate values — unavailable values and unimplemented evaluations show "—" or an explicit mock label. Never conflate quality with task result.
- **Non-intrusive**: monitoring display comes from the monitor's raw / no-decode + best_effort path. Payload decoding is isolated in `topic_probe`.
- **Per-screen image-subscription budget**: previews subscribe only while their tab is visible and release on leave; sub cameras are forced to low resolution; aggregate cards (System etc.) use orchestrator API values only and never open new subscriptions. At most one full-resolution stream at a time.
- No real paths in the frontend / no hardcoded pipelines / schemas and settings come from the backend.
- Endpoints wait for `GET /api/v1/config` before rendering (render gate). Hardcoded fallbacks are dev-only.
- Dangerous operations are suppressed while recording (double start, topic / run_id changes). Destructive operations (Discard / Delete / Reset / End early) always get a confirm modal with Cancel.
- Time-series charts are unified on uPlot.
- Shared conventions: [config](config.md).

## TBD list

- Real Quick check evaluation (two-layer design settled; Phase 3) / Advice generation logic (Phase 3)
- Dataset Recipe · Build (Phase 3)
- Substance for the Validation lifecycle (Experimental → Standard)
- Real wiring of the split transfer job and Review's transfer UI (including the split self-report signal)
- Session level, server-side Plans persistence, server-side batch Pause (Phase 2.5)
- Accessibility (WCAG 2.2 AA)
