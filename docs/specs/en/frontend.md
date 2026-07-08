<!-- AUTO-GENERATED from docs/specs/ja/frontend.md. Do not edit by hand — edit the Japanese source and run /sync-docs. -->
# frontend specification

> Status: design finalized (v1). Based on `fig_const/frontend.png`, with unspecified items fixed as recommended designs. Japanese is the source of truth (treat it as canonical). The English version `docs/specs/en/frontend.md` is an auto-generated mirror (do not edit it directly). **No authentication required.**

A backend-driven lightweight Web UI (Vite + React + TypeScript). **Usability first**. Each container's functionality is made into a **tab** and is **easily reconfigurable**.

## Role

- Recording operations / live video / topic health / Run / validation / dataset display.

## Implementation (recommended libraries)

- Base: **Vite + React + TypeScript**.
- Routing: **TanStack Router**.
- State management: **Zustand** (UI state such as tabs/layout) + **TanStack Query** (server state. SSE events are reflected into the cache via `setQueryData`).
- API client: **Orval** (auto-generates typed hooks from the orchestrator's OpenAPI).
- Charts: **uPlot** (lightweight time series). UI: **Tailwind CSS + radix-ui / shadcn + lucide**.
- Live video: **WebRTC Player** (connects to `webrtc_streamer`'s `/stream/offer`).
- Tests: **Vitest + Testing Library + MSW**.

## Input

- WebRTC video (`webrtc_streamer`; by default through the same-origin path `/webrtc`, reverse-proxied by the frontend's nginx; overridable via `WEBRTC_PUBLIC_URL`)
- REST / SSE (`api_orchestrator` `/api/v1`)

## Screen structure (tabs)

**Tabs are registry-driven** (the `tabs` definition in `GET /api/v1/config` swaps display, order, and enabled/disabled from the backend). **UI labels are in English**. The current tab structure is **Live / Graph / Probe / Recordings / Validation / Datasets / Config** (tab ids are respectively `live` / `graph` / `probe` / `runs` / `validation` / `dataset` / `config`; `probe` is a frontend-only tab the client injects even when the backend's `tabs` omit it):

- **Live** — an operations screen fusing Record + Stream + Monitor. At the top a recording hero (Operator / Task input + Start / Stop), below a Stream preview (left) and a Monitor health panel (right).
  - The Monitor enumerates subscribed topics, each row having a **RECORD checkbox**. The set of checked items becomes the target topics of the **next recording** (a selection for the next start, not a change mid-recording = `ros2 bag record` cannot be changed mid-way). Configured topics are pre-checked and sorted to the top. Each row shows a **status dot** (`inactive`/`danger`/`warning`/`ok`/`unknown`) and, when a threshold is crossed, a **shortfall badge** (observed shortfall — not true loss) plus a reason tooltip.
  - Below the Stream + Monitor grid there is a full-width, collapsible **Scope** band. Like the Graph tab it uses **add-style panels**, and each panel can **overlay** multiple series. Series come from two sources —
    - **Health** (from the monitor — **no decode**): **Frequency** (actual Hz with the expected_hz reference line) / **Shortfall vs expected** (`rate_shortfall` with the 2% / 5% threshold lines) / **Jitter**, etc. Clicking a topic name in the Monitor adds a Health panel.
    - **Signal** (from `topic_probe` — **the decoded payload value**): can overlay **different topics × multiple fields** on one chart, such as right arm / left arm. Arrays are `[0..N]`-expanded; the sample rate is **selectable per panel** (default 10Hz). "+ Signal" adds a panel ([topic_probe](topic_probe.md)).
    - Recording **REC / STOP markers** are overlaid on all panels, so you can judge "should I keep this recording / did it drop right after start?". Charts are **uPlot** (axis ticks · hover crosshair · legend · zoom). The Scope is preserved across Live's tab switches.
  - The header shows **ROS_DOMAIN_ID** and the host's **CPU / GPU** (`GET /api/v1/system`).
- **Graph** — a time-series health view where metric panels can be added and removed (**Frequency / Bandwidth / Max gap / Rate vs expected**). Overlays 1 metric × multiple topics. Since latency / loss cannot be measured with a non-intrusive monitor, they are **excluded from the menu** (per-run loss is provided via post-hoc analysis in Recordings).
- **Probe** — a generic plotter that plots **numeric fields** from `topic_probe` in add-style panels (a frontend-injected tab). Pick a topic → numeric field (arrays `[0..N]`-expanded) and **overlay different topics × multiple fields**. The sample rate is selectable per panel (default 10Hz). Decoding is handled by the isolated `topic_probe` container and **does not spill over into recording / monitoring** ([topic_probe](topic_probe.md)). Live's Scope embeds this Signal panel into the operations screen.
- **Recordings** (formerly Runs) — a recording history list (run_id / Status / Duration) + details (`manifest` / `validation` / `dataset_stats` / `loss`). A **"Run loss report" button** and an on-demand **mp4 "Video check" player**. Run deletion is also possible.
- **Validation** — a **pipeline-agnostic** dora_runner run tab. **Pipeline selection** (every enabled pipeline from `GET /api/v1/pipelines`) → **target run selection** → **params form** (auto-generated from `schemas.pipeline_forms[<id>]`) → run (`POST /api/v1/jobs`). The result is drawn by a **generic renderer** that shows the job's `summary.json` shape-independently (a PASS/FAIL badge for `result`, a `message` headline, a key/value tree for `metrics` and other fields, `artifacts`, and raw JSON). Only the bundled `fast_validation` has a bespoke checklist against the template's required-topic list. **Adding a plugin requires no edit to this tab** ([dora_plugins.md §2.5](dora_plugins.md)).
  - **Batch run**: the target-run options include **"All completed runs"**, which fans the selected pipeline out over every completed recording (one `POST /api/v1/jobs` per run). In batch mode the left pane shows a **per-run progress list** (each row: run_id + live state, then PASS/FAIL when done); clicking a row opens that run's detail card.
  - **One-click validations (pre-defined)**: config-defined preset buttons across the top (`GET /api/v1/validation/presets`). Each preset is a bundle of a `pipeline` + fixed `params`; clicking it runs over **every completed recording that pipeline has not validated yet** (`pending_run_ids`). Buttons show "N pending" and are disabled ("up to date") at 0. Presets live in the robot config `config/<robot>/validation_presets.yaml` ([config.md](config.md)).
- **Datasets** — lists exported datasets in an **operator › task › NNN tree** (`GET /api/v1/datasets`); **selecting a card shows a detail view equivalent to Recordings** (`GET /api/v1/datasets/{op}/{task}/{index}`: metadata / topic list / "Run loss report" / the mp4 "Video check" / JSON blocks for Manifest · Validation · dataset.json) in the right pane. The detail pane can be **minimized to a slim bar / expanded again** (the selection is kept; with nothing selected or while minimized the tree gets the full width back). The loss / video jobs stay keyed by the run_id from dataset.json and read the exported MCAP via `params.dataset_dir` (an mp4 cache generated before export is reused as-is). The upper section exports completed recordings (individually + "Export all" for a bulk export of all in `recorded/`). Export is a **move**: on success the recording disappears from `recorded/` and the Recordings list and appears in the Datasets tree.
- **Config** — selects and edits **robot → aspect (recording / stream / validation / validators) → option** (`GET /api/v1/config/options` · `POST /api/v1/config/select`). It lists committed robots (`config/<robot>/`) and gitignored robots (`config/local/<robot>/`); selecting a robot hot-swaps recording / stream (reflected immediately in `GET /api/v1/config`; recorder QoS / monitor expected_hz after a restart). The recording config can be edited and persisted as JSON (`PUT /api/v1/config/recording`), writing back to the active (possibly local) file.

## Data flow (SSE × cache)

- Subscribes to a single SSE stream (`GET /api/v1/events`) and reflects it into the TanStack Query cache by event kind. Components subscribe to keys and re-render.
- SSE disconnection is shown explicitly in the UI, and it reconnects automatically (`Last-Event-ID`).

## Output (APIs called)

- `POST /api/v1/record/start` / `stop`, `GET /api/v1/runs` / `GET /api/v1/runs/{id}` (RunDetail), `DELETE /api/v1/runs/{id}`, `GET /api/v1/topics/status`, `GET /api/v1/events` (SSE), `GET /api/v1/system`, `GET/PUT /api/v1/config/recording`, `GET /api/v1/files/{path}` (video_check mp4), `GET /api/v1/datasets`・`GET /api/v1/datasets/{op}/{task}/{index}` (DatasetDetail)・`POST /api/v1/datasets/export(-all)`, `POST /api/v1/jobs` (`fast_validation` / `loss_report` / `video_check`; the latter two with `params.dataset_dir` after export)

## Design policy

- **Holds no real paths / does not hardcode pipelines / the backend hands over schemas and settings / show it lightly bundled together.**
- Time-series charts are **standardized on uPlot** (the default of this spec). It provides axis ticks · crosshair · overlay · zoom out of the box. Migration leads with the Live Scope; the existing hand-rolled SVG in Graph / Probe is replaced incrementally.
- Rendering waits until `GET /api/v1/config` retrieval completes (render gate). Hardcoded fallbacks are dev only.
- During recording, suppress dangerous operations (double start, topic / run_id changes).
- Shared configuration is in [config](config.md).
