---
name: v2-screen-work
description: Standard operating procedure for implementing or fixing a kairos Console v2 screen (Collect/Review/Datasets/Validation/Monitor/Settings) — resolves current design sources, preserves existing assets and honest metrics, and applies the frontend, E2E, and browser quality gates with safe git discipline.
---

# v2 screen work

SOP for any agent implementing or fixing one screen of the kairos Console v2
redesign (Collect / Review / Datasets / Validation / Monitor / Settings).
Read this before touching `services/frontend/src/v2/<screen>/`.

## Resolve the design source

Use the first applicable source in this order:

1. The user's explicit requirement or an approved task wireframe.
2. The canonical Japanese specifications in `docs/specs/ja/`.
3. The current screen, its tests, shared v2 components, and `src/v2/tokens.ts`.
4. A versioned design artifact supplied for the task.

`.dev/kairos-console-v2.dc.html` was an untracked historical mock and is not
part of the repository. Its absence does not block an incremental feature or
fix. If a local copy happens to exist and is relevant, treat it as a historical
reference only: later user decisions, specifications, tests, and current
behavior take precedence.

Do not claim mock or pixel fidelity unless you inspected the exact artifact
used for the task. If the request is a full redesign or explicitly requires
pixel fidelity and no current design artifact is available, stop and ask for
that artifact or an explicit design decision.

## Scope discipline

- Prefer the screen's own directory, but change shared frontend, API, spec, or
  E2E files when the requested behavior genuinely crosses those boundaries.
  Keep every changed path traceable to the task.
- Reuse `src/v2/shared/Toast.tsx` and other existing shared v2 primitives.
- When parallel agents share a worktree, agree on path ownership before
  editing shared files and re-check the merged diff before validation.
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
| `src/api/client.ts`, current `src/v2/<screen>/use*.ts`, and `src/v2/pollingPolicy.ts` | Current API, state, and polling conventions. Inspect these before adding another fetch loop or store. |

## Honesty principles

Carried over from the legacy UI and non-negotiable in v2:

- Never display a metric the system cannot actually measure. Don't
  synthesize latency/loss numbers to fill a mock's visual slot.
- A shortfall against an expected count/Hz is **not** confirmed loss — word
  it as an observed shortfall, not as "packet loss" or "dropped".
- Explain empty states in words (why there's nothing to show) rather than
  leaving a blank panel with no explanation.
- Do not ship dead controls. Implement the action and its recovery path, or
  hide/disable it with a truthful explanation when the task explicitly calls
  for a future capability.

## Quality gate

Before reporting a screen done:

1. From the repository root, run `make test-fe`.
2. Add/extend vitest unit tests for any non-trivial logic you wrote (state
   machines, mapping functions) — follow existing patterns like
   `v2/collect/useBatchMachine.test.tsx`, `v2/monitor/MonitorScreen.test.tsx`,
   `v2/monitor/TopicsTable.test.tsx`.
3. Verify the real screen with `ui-check.mjs`; run it from `e2e/`, which owns
   the Playwright dependency:
   ```
   (cd services/frontend && npm run dev -- --port <pick-an-unused-port>) &
   cd e2e
   node ../.agents/skills/v2-screen-work/ui-check.mjs \
     --port <port> --tab <screen> \
     --shot ../dev_image/<screen>-default.png \
     --assert '[data-testid="…"]' [--no-scroll]
   ```
   - Pick a port nobody else is using — check `ps aux | grep vite` first,
     other agents' dev servers are already running in this worktree.
   - Add `data-testid` hooks to your own components as you go (see
     `v2/collect/ControlCard.tsx` for the convention — `phase-title`,
     `elapsed`, etc.) so assertions target stable hooks, not brittle CSS.
   - All work-process screenshots — from ui-check.mjs, a browser tool, or any
     other tool — go into the **worktree-root `dev_image/`** (gitignored).
     From `e2e/` that is `../dev_image/`.
   - If `e2e/node_modules` or Chromium is unavailable, do not install packages
     unless the user authorizes it. Use an available browser tool for the same
     assertions, or report the browser gate as blocked rather than claiming it
     passed.
   - Pass `--no-scroll` for any screen whose brief requires no vertical
     scroll (Collect is the current example).
   - Kill your dev server when done so the port is free for others.
4. For a UI or behavior change, build the changed service image and run the
   acceptance suite against it:
   ```
   make build frontend
   make test-e2e
   ```
   If the suite cannot run because its documented external prerequisites are
   absent, report the exact blocker and do not substitute unit tests for it.

## Git discipline

- Do not commit, push, or open a PR without explicit user authorization.
- Stage only task-owned paths. In a dirty or shared worktree, never use blanket
  staging that could sweep unrelated changes into the commit.
- If `git add`/`git commit` fails on a `index.lock` error, another agent is
  mid-commit — wait ~10s and retry. Don't force-remove the lock file.
- Use an English Conventional Commit message when a commit is authorized.
- When explicit multi-agent work is active, use the available collaboration
  tools and agreed ownership protocol; do not assume a tool named
  `SendMessage` or a coordinator named `main` exists.
