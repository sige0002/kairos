# Check a running Console v2 screen

Use an available browser tool, or `ui-check.mjs` from `e2e/`, which owns the
Playwright dependency. Use an existing suitable task server or start one on an
unused port; check listening ports and current Vite processes first.

```bash
# From services/frontend, only if a task server is needed:
npm run dev -- --port <unused-port>

# From e2e, in another tool session:
node ../.agents/skills/v2-screen-work/ui-check.mjs \
  --port <port> --tab <screen> \
  --shot ../dev_image/<screen>-default.png \
  --assert '[data-testid="<stable-hook>"]' --no-scroll
```

`--no-scroll` is required only when the brief forbids vertical scrolling
(Collect is the established example). Without it, a scroll warning is not an
assertion pass. Use stable existing test hooks and add meaningful ones where
needed; avoid brittle selectors or test-only component redesigns.

Exercise the changed flow and its error/empty states, not just default render.
For a feature gate such as Review's `splitMode`, check both states and verify
that hidden columns/buttons are absent in the disabled mode.

All work-process screenshots go in worktree-root `dev_image/` (gitignored),
including screenshots taken by another browser tool. Inspect them before
claiming visual evidence. Clean up only the dev server started for this task.
If Playwright or Chromium is unavailable, do not install without authorization;
use an available equivalent browser tool or report the browser gate blocked.
