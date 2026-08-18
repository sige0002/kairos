---
name: v2-ui-review
description: Strict evidence-based review protocol for a completed kairos Console v2 screen — verifies task scope, current design requirements, merged-state frontend and E2E gates, independent browser behavior, accessibility, reuse, and honest system-state communication.
---

# v2 UI review

Strict review protocol for a kairos Console v2 screen once its implementing
agent reports it done. Run this whether you're the director or a dedicated
review agent. **Explicit user mandate: do not soften findings because the
implementer is a teammate.** A finding is a finding regardless of who wrote
the code.

Companion tool: `../v2-screen-work/ui-check.mjs` (Playwright headless
verification — see that skill for full usage).

## 1. Scope check by evidence

Inspect the task diff, or the commit when one exists:

```
git diff --stat
git diff -- <task-owned-paths>
```

Every changed path must be traceable to the requested behavior. Cross-layer
changes to a shared component, API, specification, or E2E test are valid when
the feature requires them; unrelated edits and duplicate screen-local versions
of existing shared primitives are findings. In a shared worktree, separate the
task diff from pre-existing user changes before judging scope.

## 2. Re-run the full quality gate on merged state

Re-run on the current worktree state, not just an isolated commit:

```
make test-fe
make build frontend
make test-e2e
```

The service image must be rebuilt before E2E so the acceptance suite cannot
pass against stale code. Attribute any failure with evidence. If a documented
external prerequisite is unavailable, report the gate as blocked; do not call
the review PASS on unit tests alone.

## 3. Design and copy fidelity

Resolve the applicable design source in this order:

1. The user's explicit requirement or approved task wireframe.
2. `docs/specs/ja/`.
3. Current behavior, tests, shared v2 components, and tokens.
4. A versioned design artifact supplied for the task.

Compare layout hierarchy, panel inventory, responsive behavior, typography,
states, action names, and error/recovery copy against those sources. Verify
that later decisions override older references.

The former `.dev/kairos-console-v2.dc.html` was untracked and is not a required
review input. If an exact artifact is absent, record `mock fidelity: not
evaluated` rather than inventing or claiming fidelity. Absence becomes a
blocker only when the request explicitly requires a full redesign or pixel
comparison with that artifact.

## 4. Independent Playwright verification

Take an independent screenshot and exercise the important states with
`ui-check.mjs`. Run it from `e2e/`, which owns Playwright:

```
(cd services/frontend && npm run dev -- --port <unused-port>) &
cd e2e
node ../.agents/skills/v2-screen-work/ui-check.mjs \
  --port <port> --tab <screen> \
  --shot ../dev_image/<screen>-review.png \
  --assert '[data-testid="…"]' ...
```

- Exercise the key flows the task describes for that screen, not just the
  default render.
- If the screen has a feature gate (e.g. Review's `splitMode` for the
  transfer UI), check **both** states — a `--full-flow` module or two
  separate invocations. Confirm the non-split state truly hides the
  transfer column/button rather than just disabling it.
- Kill the dev server when done.

## 5. Principle compliance

- Reuse-list assets are **imported**, not re-implemented — inspect the diff
  and grep for duplicated logic (e.g. a hand-rolled WebRTC setup, a second
  uPlot redraw call, a parallel pipeline-form). If the screen needed
  something the reuse list's asset doesn't do, justify the extension rather
  than silently forking the logic.
- No new subscriptions/polling introduced beyond what's already wired
  (`useEventStream`, existing hooks) — grep for new `EventSource(`,
  `setInterval(`, or raw `fetch`/WebSocket loops the brief didn't ask for.
- Empty states are explained in words, not blank panels.
- No-scroll requirement is met where the brief requires it (`ui-check.mjs`
  without `--no-scroll` only warns; re-run **with** `--no-scroll` for any
  screen that must not scroll and treat a warning from the plain run as a
  finding too).

## 6. User-task evaluation

Once steps 1-5 pass, evaluate at least one representative user task against
the running screen. Prefer an existing Playwright scenario in `e2e/tests/`;
add or extend one when the new behavior is not covered. Check that the user
can discover the action, understand current state, recover from failure, and
confirm the outcome without implementation knowledge.

An optional persona harness may be used only when its runner and story are
actually present. It supplements the standard E2E and browser gates; it never
replaces them.

## Verdict

Report in this format, using the active collaboration channel when another
agent owns the implementation:

```
VERDICT: PASS | FAIL

Findings (severity-ordered — scope violations and correctness bugs first,
then fidelity gaps, then polish):
1. <file>:<line> — <problem> — <required fix>
2. ...
```

If FAIL, re-review from step 1 after the fix. A partial diff check is not
enough because a fix can violate scope or break a gate.
