---
name: v2-ui-review
description: Strict fidelity-review protocol for a completed kairos Console v2 screen — verifies scope, re-runs the quality gate on merged state, checks structural/copy fidelity against the design mock, independently re-verifies with Playwright, and checks reuse/honesty principle compliance. Explicit user mandate — no leniency toward teammate agents.
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

Don't take "I only touched my screen" on faith — check the commit:

```
git show --stat <commit>
```

Every changed path must be under that screen's own
`services/frontend/src/v2/<screen>/` (plus, rarely, a genuinely new test file
in the same directory). Any touch to `App.tsx`, `v2/tabs.ts`, `v2/tokens.ts`,
`src/config.ts`, or another screen's directory is an automatic finding —
flag it even if the change itself looks harmless.

## 2. Re-run the full quality gate on merged state

Agents commit without seeing each other's work, so a clean individual commit
can still break when merged. Re-run on the current branch tip, not just the
one commit:

```
cd services/frontend && npm run build && npm test && npm run lint
```

Any failure here is a finding, regardless of whether it "obviously" isn't
this screen's fault — track down which change caused it and say so.

## 3. Structural fidelity vs. the mock

Reopen `.dev/kairos-console-v2.dc.html` at the screen's
`data-screen-label="<Name>"` block and compare, concretely:

- Grid layout: `grid-template-columns` values match (e.g. Review is
  `216px 1fr 400px`, Validation is `290px 1fr`, Settings is
  `216px 250px 1fr`) — not just "looks like 3 columns."
- Panel inventory: every panel/card/section in the mock section is present
  (or explicitly deferred as a documented placeholder per that screen's
  brief — check `.dev/next-session-agent-briefs.md`).
- Typography: mono vs sans used in the same places as the mock (numbers,
  ids, timestamps are typically mono).
- Chip/button colors match the mock's palette (Tailwind default == mock hex,
  so a wrong color is a wrong Tailwind class, not a rounding difference).
- **Exact copy strings** — these are known fixed strings the mock uses
  verbatim; a paraphrase is a finding:
  - Validation footer note: "Experimental results never feed Review
    automatically. Promote a Candidate to make it Standard." (mock line 592)
  - Monitor shortfall label: "observed shortfall — no confirmed loss" (mock
    line 719) — never "packet loss" or "dropped" (see honesty principles).
  - Settings/Robots notice: "Applies from the next episode. Changing
    expected Hz thresholds does not affect the episode currently being
    recorded." (mock line 914)
  - Settings/Plans notice: "Applies from the next episode. Current episode
    plans are unaffected." (mock line 982)
  - Re-grep the mock for the screen under review — this list is not
    exhaustive, it's a reminder that copy fidelity is checked at all.

## 4. Independent Playwright verification

**Never trust the implementer's own screenshots** — take your own with
`ui-check.mjs`:

```
cd services/frontend
npm run dev -- --port <unused-port> &
node ../../.claude/skills/v2-screen-work/ui-check.mjs \
  --port <port> --tab <screen> \
  --shot .dev/shots/<screen>-review.png \
  --assert '[data-testid="…"]' ...
```

- Exercise the key flows the brief describes for that screen, not just the
  default render.
- If the screen has a feature gate (e.g. Review's `splitMode` for the
  transfer UI), check **both** states — a `--full-flow` module or two
  separate invocations. Confirm the non-split state truly hides the
  transfer column/button rather than just disabling it.
- Kill the dev server when done.

## 5. Principle compliance

- Reuse-list assets are **imported**, not re-implemented — `git show <commit>`
  and grep for duplicated logic (e.g. a hand-rolled WebRTC setup, a second
  uPlot redraw call, a parallel pipeline-form). If the screen needed
  something the reuse list's asset doesn't do, that's a design question for
  the director, not license to fork the logic.
- No new subscriptions/polling introduced beyond what's already wired
  (`useEventStream`, existing hooks) — grep for new `EventSource(`,
  `setInterval(`, or raw `fetch`/WebSocket loops the brief didn't ask for.
- Empty states are explained in words, not blank panels.
- No-scroll requirement is met where the brief requires it (`ui-check.mjs`
  without `--no-scroll` only warns; re-run **with** `--no-scroll` for any
  screen that must not scroll and treat a warning from the plain run as a
  finding too).

## 6. Blind persona test (functional/UX)

Only once steps 1-5 pass — this is a real, expensive end-to-end run, don't
burn it on a screen that still has scope violations or a broken build.

```
.dev/persona-tests/run-persona-test.sh <story.md> [port]
```

- Runs codex (gpt-5.6-terra, high reasoning) against the real running dev
  server via the Playwright MCP, headless, 1920×1080. The tester model has
  **zero implementation knowledge** — no source access, no API calls, only a
  persona + a step-by-step story, exactly like an actual end user reading the
  screen. Point `[port]` at your running dev server (script defaults to 5190).
- `.dev/persona-tests/operator-collect-story.md` is the template: a
  persona (who they are, what they don't know) + a numbered shift narrative
  to act out in the UI + a structured report request at the end. Write a new
  story file per screen/flow under review (a Review-focused ML-engineer
  persona, a Settings-focused robot-engineer persona, etc.) — don't reuse
  Collect's story for a different screen.
- Redirect output to `.dev/persona-tests/results/` and read it for concrete
  friction: wrong clicks before finding a control, confusing or misleading
  text, moments of "could they tell if it was actually recording?". These are
  UX/functional findings — fold them into the verdict below (file:line where
  it's a clear copy/element fix; otherwise name the flow and quote what
  confused the tester).

## Verdict

Report back to the owning agent (`SendMessage`) in this format:

```
VERDICT: PASS | FAIL

Findings (severity-ordered — scope violations and correctness bugs first,
then fidelity gaps, then polish):
1. <file>:<line> — <problem> — <required fix>
2. ...
```

If FAIL, wait for the fix and re-review from step 1 — a partial re-check
against just the diff is not enough, since a fix can itself violate scope or
break the gate. Findings must be corrected, not negotiated down.
