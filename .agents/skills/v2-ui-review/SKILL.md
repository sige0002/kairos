---
name: v2-ui-review
description: Review a completed kairos Console v2 screen against its brief, current specs, browser behavior, shared contracts, and final-state validation evidence.
---

# Console v2 review

Review findings on their evidence regardless of who implemented the screen.
The explicit user mandate is to report teammate defects with the same rigor.
This review inspects and validates; it does not authorize commit or publication.

## Review inputs

Inspect the complete task diff, including relevant untracked files, and separate
pre-existing work. Each changed path should support the requested behavior;
necessary shared-component, API, spec, and E2E edits are valid cross-layer work.

Resolve design intent from the user's brief, Japanese specs, current behavior/
tests/tokens, then relevant supplied artifacts. Do not claim mock fidelity to an
uninspected artifact. The missing historical `.dev/kairos-console-v2.dc.html`
blocks only a request that actually requires comparison with that artifact.

## Validate the final state

Check evidence for `make test-fe`, affected image builds, and `make test-e2e`
on the final integrated state. E2E must use rebuilt images for changed services.
Reuse applicable evidence; rerun affected gates if fixes or integration have
changed the tested state. A missing required gate remains blocked and cannot
be called PASS on unit tests alone.

Independently exercise the important user flow and inspect a screenshot using
[the browser-check procedure](../v2-screen-work/references/browser-check.md).
Check feature-gate variants, relevant keyboard/focus behavior, responsive states,
and any no-scroll requirement. An optional persona harness supplements these
gates only when its runner/story exists; generated personas are not user-study
evidence.

## Findings to look for

- Violations of [shared UI contracts](../v2-screen-work/references/ui-contracts.md):
  duplicated WebRTC/chart/pipeline/threshold logic, extra SSE connections, or
  fetch/polling loops that bypass existing owners.
- Fabricated metrics, mislabeled shortfalls, unexplained empty states, dead
  controls, unclear action receipts, or recovery requiring implementation knowledge.
- Layout, state, wording, or accessibility that prevents the task described in
  the brief, including behavior before and after the changed screen.

Report `VERDICT: PASS | FAIL`, followed by severity-ordered findings with
file:line, a concrete scenario, evidence, and the needed correction. List blocked
or untested gates explicitly. After a fix, review its effects and any impacted
scope/gates; do not restart unrelated checks without a new reason.
