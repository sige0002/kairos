---
name: v2-screen-work
description: Implement or fix kairos Console v2 screens using current design sources, shared assets, honest metrics, and the required browser/E2E gates.
---

# Console v2 screen work

For Collect / Review / Datasets / Validation / Monitor / Settings, resolve the
requested behavior from the user's brief, Japanese specs, and current code/tests
and tokens, in that order. Use a supplied versioned design artifact where it
applies. The former untracked `.dev/kairos-console-v2.dc.html` is historical and
its absence does not block an incremental fix. Exact pixel fidelity needs the
actual referenced artifact; do not claim it without inspection.

Change shared components, APIs, specs, or E2E tests when the behavior crosses
those boundaries. In parallel work, agree on shared-file ownership. Do not run
`npm install` or add dependencies without authorization; preserve the shared
lockfile and use an available browser tool when possible.

## Preserve the screen's contracts

Read [ui-contracts.md](references/ui-contracts.md) for the shared assets relevant
to the touched feature. It records fixes that must survive a layout change,
including WebRTC MTU/ICE handling, uPlot empty buffers, pipeline forms, monitor
thresholds, and the existing SSE store.

- Reuse v2 shared primitives such as `src/v2/shared/Toast.tsx`.
- Collect logic belongs in `v2/collect/hooks/`; pure transitions belong in
  `machine/`. Do not accumulate new logic in `useBatchMachine.ts`.
- Display only measured metrics. An expected-count/Hz shortfall is not confirmed
  packet loss. Explain empty and unavailable states in task language.
- Controls need a real action and recovery path. A future capability may be
  hidden or disabled with an honest explanation when the brief calls for it.

## Evidence required for UI/behavior changes

Use `make test-fe` for frontend build/tests/lint and meaningful tests for new
logic. Inspect the changed screen and important states using
[browser-check.md](references/browser-check.md), including keyboard behavior and
any no-scroll requirement. Work screenshots go in worktree-root `dev_image/`.

Build every service image affected by the changed flow, then run `make test-e2e`.
The acceptance suite does not build images; a pass against stale images cannot
validate source changes. See [e2e/README.md](../../../e2e/README.md) for external
prerequisites and covered scenarios. Report unavailable required gates as
blocked rather than substituting unit-test evidence.

Reuse valid evidence for the final integrated state. After a fix or concurrent
change, rerun the affected checks. Use `v2-ui-review` for a requested completed-
screen review. Git authorization and staging boundaries remain in AGENTS.md.
