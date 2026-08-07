---
name: v2-screen-work
description: Standard operating procedure for implementing or fixing a kairos Console v2 screen (Collect/Review/Datasets/Validation/Monitor/Settings) — where the design mock lives, which existing assets to reuse vs never touch, the honesty rules for displayed metrics, the build/test/lint/UI-check quality gate, and git discipline in a worktree shared by parallel agents.
---

# v2 screen work

SOP for any agent implementing or fixing one screen of the kairos Console v2
redesign (Collect / Review / Datasets / Validation / Monitor / Settings).
Read this before touching `services/frontend/src/v2/<screen>/`.

## The design source

- The mock is `.dev/kairos-console-v2.dc.html` (repo root, gitignored — if it's
  missing, ask the director to refetch it; do not fabricate layout from
  memory).
- It's a template dump, not plain HTML. Constructs you'll see:
  - `<sc-if value="{{ cond }}">…</sc-if>` — conditional render.
  - `<sc-for list="{{ items }}" as="x">…</sc-for>` — loop.
  - `{{ expr }}` — interpolation.
  - `style-hover="…"` — CSS applied on hover, separate from the base `style`.
- Each screen is one `<div data-screen-label="<Name>">` block — `grep -n
  'data-screen-label="Review"' .dev/kairos-console-v2.dc.html` to jump to
  yours. The `data-screen-label` value is the exact screen name (Collect,
  Review, Datasets, Validation, Monitor, Settings).
- Sample state, the CSS/color tables (e.g. `tabDefs`), and interaction logic
  live in the trailing `<script type="text/x-dc" data-dc-script">` block
  (`class Component extends DCLogic { state = {...} }`, starting roughly at
  line 1000) — read this to know what fields/states a section actually cycles
  through before you invent your own.
- **Tailwind's default palette equals the mock's hexes 1:1** (`bg-teal-600` is
  literally `#0d9488`, etc.) — reach for Tailwind utility classes first. Use
  `src/v2/tokens.ts` only where you need a raw JS hex (inline SVG strokes,
  `<canvas>`/uPlot series colors) — don't hand-copy hex values elsewhere.

## Scope discipline

Five-plus other agents are editing sibling `src/v2/<screen>/` directories in
this same worktree concurrently. To avoid collisions:

- Write only under your own `services/frontend/src/v2/<screen>/`.
- Never edit shared files: `src/App.tsx`, `src/v2/tabs.ts`, `src/v2/tokens.ts`,
  `src/config.ts`, or another screen's directory. If the shell genuinely needs
  a change, report it to the director instead of editing it yourself.
- Each screen owns its own local toast component inside its own directory
  (see `v2/review/Toast.tsx`, `v2/settings/Toast.tsx`,
  `v2/validation/Toast.tsx` for the pattern) — don't add a shared one.
- No `npm install`. If a dependency genuinely seems missing, stop and report
  it rather than installing — the lockfile is shared.

## Reuse, don't rewrite

These assets carry fixes for bugs that will silently regress if rewritten.
Import them; don't reimplement their logic:

| Asset | Why it must be reused as-is |
|---|---|
| `src/features/stream/useWebRtcStream.ts` | Carries the MTU workaround (PACKET_MAX cap + IPv6 ICE-candidate drop) for the Tailscale black-screen bug. Rewriting the WebRTC setup reintroduces it. |
| `src/features/probe/UplotChart.tsx` | Contains the empty-buffer redraw guard. Calling uPlot's `redraw()` with no args on an empty buffer permanently wedges the chart — never bypass this component to call uPlot directly. |
| `src/features/validation/PipelineForm.tsx` + `SummaryResult.tsx` | The schema-driven form and pipeline-agnostic result renderer — the whole point is that Validation stays pipeline-agnostic. Embed these into the new layout; don't build a parallel form. |
| `src/features/monitor/useMonitorRows.ts` + `thresholds.ts` | Hz/expected-Hz/bandwidth/gap → status-chip logic. Reimplementing risks silently diverging thresholds between Monitor and elsewhere. |
| `src/sse/useEventStream.ts` / `src/store/uiStore.ts` | SSE wiring, already connected to the v2 header in A1. Read from the store; don't open a second connection. |
| `src/features/system/SystemInfo.tsx` | System gauges — an aggregated-API-only source (see "no new subscriptions" below). |
| `src/features/runs/RunsTab.tsx`, `src/features/dataset/DatasetTab.tsx`, `src/features/config/ConfigTab.tsx`, `src/features/graph/useMetricHistory.ts` | Existing data-fetching to map into the new screens where your brief calls for real (not mock) wiring. |

## Honesty principles

Carried over from the legacy UI and non-negotiable in v2:

- Never display a metric the system cannot actually measure. Don't
  synthesize latency/loss numbers to fill a mock's visual slot.
- A shortfall against an expected count/Hz is **not** confirmed loss — word
  it as an observed shortfall, not as "packet loss" or "dropped".
- Explain empty states in words (why there's nothing to show) rather than
  leaving a blank panel with no explanation.
- Mock-only interactive elements without real backend support yet (Phase 1)
  should say what they'd do (e.g. a toast) rather than faking a real
  success/persisted state.

## Quality gate

Before reporting a screen done or committing:

1. `cd services/frontend && npm run build && npm test && npm run lint` — all
   green.
2. Add/extend vitest unit tests for any non-trivial logic you wrote (state
   machines, mapping functions) — follow existing patterns like
   `v2/collect/useBatchMachine.test.tsx`, `v2/monitor/MonitorScreen.test.tsx`,
   `v2/monitor/TopicsTable.test.tsx`.
3. UI verification with `ui-check.mjs` (this directory) — **never** just eyeball
   it, and never skip this because the build passed:
   ```
   cd services/frontend
   npm run dev -- --port <pick-an-unused-port> &
   node ../../.claude/skills/v2-screen-work/ui-check.mjs \
     --port <port> --tab <screen> \
     --shot ../../dev_image/<screen>-default.png \
     --assert '[data-testid="…"]' [--no-scroll]
   ```
   - Pick a port nobody else is using — check `ps aux | grep vite` first,
     other agents' dev servers are already running in this worktree.
   - Add `data-testid` hooks to your own components as you go (see
     `v2/collect/ControlCard.tsx` for the convention — `phase-title`,
     `elapsed`, etc.) so assertions target stable hooks, not brittle CSS.
   - ALL work-process screenshots — from ui-check.mjs, the Playwright MCP
     browser, or any other tool — go into the **worktree-root `dev_image/`**
     (gitignored). From `services/frontend` that's `../../dev_image/`. Never
     drop them at the repo root, in `.dev/`, or in `.playwright-mcp/`.
   - If the `playwright` npm package isn't installed (ui-check.mjs then fails
     at import), don't `npm install` it — fall back to the Playwright MCP
     browser tools for the same checks (navigate to the dev server, assert
     your testids via snapshot, take a screenshot) and still save the
     screenshot into `dev_image/`. Note the fallback in your report.
   - Pass `--no-scroll` for any screen whose brief requires no vertical
     scroll (Collect is the current example).
   - Kill your dev server when done so the port is free for others.

## Git discipline (shared worktree)

- Stage only your own paths, e.g. `git add services/frontend/src/v2/review/`
  — never `git add -A` or `git add .`. Other agents have uncommitted work in
  sibling directories; a blanket add will sweep it into your commit.
- If `git add`/`git commit` fails on a `index.lock` error, another agent is
  mid-commit — wait ~10s and retry. Don't force-remove the lock file.
- Commit message format:
  ```
  feat(frontend): v2 <Screen> screen — <one-line summary>

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  ```

## Team protocol

- Send a progress ping to `main` roughly every 10 minutes via `SendMessage`
  — **one line, max** (user mandate). E.g. "Review: EpisodeTable + detail
  panel done, wiring transfer column next." Save the detail for the
  completion report.
- Report any blocker that's lasted more than 5 minutes immediately — still
  one line; expand only if `main` asks a follow-up.
- Completion report to `main` is the one exception and may be detailed: commit
  hash, screenshot paths, and the gate results (build/test/lint pass or fail,
  with the failure if any).
