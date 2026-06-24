<!-- AUTO-GENERATED from docs/specs/ja/frontend.md. Do not edit by hand — edit the Japanese source and run /sync-docs. -->

# frontend Specification

> Status: design finalized (v1). Based on `fig_const/frontend.png`, with unstated items finalized as the recommended design. Japanese is the source of truth (it governs). The English version `docs/specs/en/frontend.md` is an auto-generated mirror (do not edit it directly). **No authentication required.**

A backend-driven lightweight Web UI (Vite + React + TypeScript). **Usability first**. Each container feature is made into a **tab**, and is **easily reconfigurable**.

## Role

- Recording operations / live video / topic health / Run / validation / dataset display.

## Implementation (recommended libraries, following `../rosbag-view`)

- Base: **Vite + React + TypeScript**.
- Routing: **TanStack Router**.
- State management: **Zustand** (UI state such as tabs/layout) + **TanStack Query** (server state. Reflects SSE events into the cache via `setQueryData`).
- API client: **Orval** (auto-generates typed hooks from the orchestrator's OpenAPI).
- Charts: **uPlot** (lightweight time series). UI: **Tailwind CSS + radix-ui / shadcn + lucide**.
- Live video: **WebRTC Player** (connects to `webrtc_streamer`'s `/stream/offer`).
- Testing: **Vitest + Testing Library + MSW**.

## Input

- WebRTC video (`webrtc_streamer`, directly to `WEBRTC_PUBLIC_URL`)
- REST / SSE (`api_orchestrator` `/api/v1`)

## Screen Layout (tabs)

Each container feature = 1 tab. **Tabs are registry-driven** (via the `tabs` definition in `GET /api/v1/config`, the display, order, and enabled/disabled state are swapped in from the backend):

- **Record** — Topic selection / Topic Health / Alert / recording Start/Stop. Before starting, displays the estimated bandwidth and the free space at the destination.
- **Monitor** — Hz / Late / Gap / Loss / Bandwidth dashboard + Alert.
- **Stream** — live video preview (multi-camera layout, retry on connection failure, codec-unsupported display).
- **Runs** — list (run_id / Status / Duration) + details (Preview / Validation / Dataset Stats, a raw JSON view of the manifest).
- **Pipelines** — schema-driven execution form (stage3. Disabled by default).

## Data Flow (SSE × cache)

- Subscribes to a single SSE stream (`GET /api/v1/events`) and reflects it into the TanStack Query cache by event kind. Components subscribe to keys and re-render.
- SSE disconnection is shown explicitly in the UI, and it reconnects automatically (`Last-Event-ID`).

## Output (APIs called)

- `POST /api/v1/record/start` / `stop`, `GET /api/v1/runs`, `GET /api/v1/topics/status`, `GET /api/v1/events` (SSE), `POST /api/v1/jobs` (stage3)

## Design Principles

- **Holds no real paths / does not hardcode pipelines / the backend passes schemas and settings / shows things compactly and concisely.**
- Endpoints wait to render until `GET /api/v1/config` retrieval is complete (render gate). Hardcoded fallback is dev-only.
- During recording, dangerous operations (double start, changing topic / run_id) are suppressed.
- Shared settings are in [config](config.md).
