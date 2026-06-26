<!-- AUTO-GENERATED from docs/specs/ja/frontend.md. Do not edit by hand — edit the Japanese source and run /sync-docs. -->
# frontend specification

> Status: design finalized (v1). Based on `fig_const/frontend.png`, with unspecified items fixed as recommended designs. Japanese is the source of truth (treat it as canonical). The English version `docs/specs/en/frontend.md` is an auto-generated mirror (do not edit it directly). **No authentication required.**

A backend-driven lightweight Web UI (Vite + React + TypeScript). **Usability first**. Each container's functionality is made into a **tab** and is **easily reconfigurable**.

## Role

- Recording operations / live video / topic health / Run / validation / dataset display.

## Implementation (recommended libraries, following `../rosbag-view`)

- Base: **Vite + React + TypeScript**.
- Routing: **TanStack Router**.
- State management: **Zustand** (UI state such as tabs/layout) + **TanStack Query** (server state. SSE events are reflected into the cache via `setQueryData`).
- API client: **Orval** (auto-generates typed hooks from the orchestrator's OpenAPI).
- Charts: **uPlot** (lightweight time series). UI: **Tailwind CSS + radix-ui / shadcn + lucide**.
- Live video: **WebRTC Player** (connects to `webrtc_streamer`'s `/stream/offer`).
- Tests: **Vitest + Testing Library + MSW**.

## Input

- WebRTC video (`webrtc_streamer`, directly to `WEBRTC_PUBLIC_URL`)
- REST / SSE (`api_orchestrator` `/api/v1`)

## Screen structure (tabs)

**Tabs are registry-driven** (the `tabs` definition in `GET /api/v1/config` swaps display, order, and enabled/disabled from the backend). **UI labels are in English**. The current tab structure is **Live / Graph / Recordings / Validation / Datasets / Config** (tab ids are respectively `live` / `graph` / `runs` / `validation` / `dataset` / `config`):

- **Live** — an operations screen fusing Record + Stream + Monitor. At the top a recording hero (Operator / Task input + Start / Stop), below a Stream preview (left) and a Monitor health panel (right).
  - The Monitor enumerates subscribed topics, each row having a **RECORD checkbox**. The set of checked items becomes the target topics of the **next recording** (a selection for the next start, not a change mid-recording = `ros2 bag record` cannot be changed mid-way). Configured topics are pre-checked and sorted to the top.
  - The header shows **ROS_DOMAIN_ID** and the host's **CPU / GPU** (`GET /api/v1/system`).
- **Graph** — a time-series health view where metric panels can be added and removed (**Frequency / Bandwidth / Max gap / Rate vs expected**). Since latency / loss cannot be measured with a non-intrusive monitor, they are **excluded from the menu** (per-run loss is provided via post-hoc analysis in Recordings).
- **Recordings** (formerly Runs) — a recording history list (run_id / Status / Duration) + details (`manifest` / `validation` / `dataset_stats` / `loss`). A **"Run loss report" button** and an on-demand **mp4 "Video check" player**. Run deletion is also possible.
- **Datasets** — lists exported datasets in an **operator › task › NNN tree** (`GET /api/v1/datasets`). The lower section exports completed recordings (individually + "Export all" for a bulk export of all in `recorded/`). Export is a **move**: on success the recording disappears from `recorded/` and the Recordings list and appears in the Datasets tree.
- **Config** — edits and persists the recording config (the entire `RECORDING_CONFIG`) from the UI (`PUT /api/v1/config/recording`).

## Data flow (SSE × cache)

- Subscribes to a single SSE stream (`GET /api/v1/events`) and reflects it into the TanStack Query cache by event kind. Components subscribe to keys and re-render.
- SSE disconnection is shown explicitly in the UI, and it reconnects automatically (`Last-Event-ID`).

## Output (APIs called)

- `POST /api/v1/record/start` / `stop`, `GET /api/v1/runs` / `GET /api/v1/runs/{id}` (RunDetail), `DELETE /api/v1/runs/{id}`, `GET /api/v1/topics/status`, `GET /api/v1/events` (SSE), `GET /api/v1/system`, `GET/PUT /api/v1/config/recording`, `GET /api/v1/files/{path}` (video_check mp4), `GET /api/v1/datasets`・`POST /api/v1/datasets/export(-all)`, `POST /api/v1/jobs` (`fast_validation` / `loss_report` / `video_check`)

## Design policy

- **Holds no real paths / does not hardcode pipelines / the backend hands over schemas and settings / show it lightly bundled together.**
- Rendering waits until `GET /api/v1/config` retrieval completes (render gate). Hardcoded fallbacks are dev only.
- During recording, suppress dangerous operations (double start, topic / run_id changes).
- Shared configuration is in [config](config.md).
