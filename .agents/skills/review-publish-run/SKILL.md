---
name: review-publish-run
description: 'Finish a completed kairos change through an explicitly requested endpoint: independent review, final validation, scoped commit, push, image build, stack startup, and health verification. Use when the user says phrases such as “レビューしてコミットまで”, “レビューしてコミット・pushまで”, “レビューコミットプッシュmake build up”, “レビュー後にbuildして起動”, or “finish, publish, and run it”. Trigger only when the user explicitly requests review plus at least commit, push, image build, or stack start; do not infer commit, push, PR, merge, build, or startup authority from an ordinary implementation or review request. Use github-issue-pr only when the user explicitly asks to create an issue; use an available PR-publication workflow for a PR-only request.'
---

# Review, publish, and run

Complete a kairos change without skipping evidence gates or broadening the user's authority. Treat the last explicitly requested stage as the endpoint and stop there.

## Establish authority and scope

1. Read the current user request, `AGENTS.md`, and any task-specific skills.
2. Map the requested endpoint before changing external state:
   - review: inspect and validate only;
   - commit: review, validate, and create a local commit;
   - push: push reviewed task commit(s); if task changes are still uncommitted and commit was not requested, ask before creating one;
   - build: run the requested image build at the requested point without inferring commit or push;
   - up/start: start the stack only when explicitly requested; it does not imply build, commit, or push.
3. Never add an unrequested PR, merge, tag, release, force-push, deployment, or destructive cleanup. If the endpoint is materially ambiguous, stop before the first ambiguous side effect.
4. Inspect `git status --short --branch`, the full `git diff`, and the full `git diff --cached` before doing task staging. Inspect every task-owned untracked file explicitly because both diffs omit it. Separate task-owned paths from pre-existing user changes. If the index already contains any unrelated staged entry, stop before commit rather than including or unstaging it. Do not rewrite or clean unrelated paths.

## Run the evidence gates

Select gates from the current `AGENTS.md`, manifests, Makefile, and CI rather than copying stale commands into the workflow.

- Run focused tests while iterating, then the applicable final repository gate on the complete worktree state.
- For frontend or UI changes, run `make test-fe`, run `make build <affected services>` (at least `frontend`), then run `make test-e2e`. These are validation prerequisites: the targeted image build feeds an isolated E2E stack that is removed afterward, and is distinct from a requested final all-image build or persistent `make up`. A request ending at commit or push omits only those final runtime stages. If the user explicitly prohibits any image build or temporary stack startup, report the required UI gate as blocked and stop before publication. E2E never proves current source unless every service image used by the changed path was rebuilt first. Exercise the changed browser state and accessibility path when the applicable UI skills require it.
- For Python changes, run the affected package tests and the applicable `make test-py`, Ruff lint, and Ruff format-check gates.
- For Compose, deployment, ROS, or data-flow changes, run the corresponding checks documented in `AGENTS.md` and CI, plus the relevant robotics or container skill.
- Synchronize an edited Japanese canonical document to its English mirror with `sync-docs` before final review.
- Do not advance to commit while a required test fails or a required gate is unverified. Distinguish a known non-failing warning from a failure in the report.
- A gate run in a dirty worktree proves that combined worktree, not the task commit by itself. If unrelated changes could affect the result, validate the resulting task commit in a clean temporary worktree or report the isolated gate as blocked. Do not claim dirty-worktree evidence for an isolated commit.

## Obtain an independent review

When the user requested review and an independent agent is available, give a read-only reviewer the task brief, task diff, and validation evidence. Ask for:

- findings ordered by severity, with file and line, concrete failure scenario, and verified versus conjectured status;
- scope violations, correctness, recovery behavior, accessibility, test gaps, and security concerns appropriate to the change;
- an explicit `PASS` or `FAIL` verdict.

Do not tell the reviewer the desired verdict or hide known weak areas. If the verdict is `FAIL`, fix actionable findings, rerun every affected gate, and ask the same reviewer to re-check. Do not publish until the final verdict is `PASS`. If no independent reviewer is available, perform a deliberate self-review and disclose that limitation instead of calling it independent.

## Commit only the reviewed change

Immediately before committing:

1. Run `git diff --check` and inspect the final task diff, including task-owned untracked files, again.
2. Stage explicit task-owned paths; do not use a blanket add in a dirty worktree.
3. Inspect the full `git diff --cached` as well as `--check`, `--stat`, and `--name-only`. Stop if any staged path or hunk is not task-owned.
4. Run `git diff --name-only` and confirm no task-owned staged path also has an unstaged layer. The confidential-name checker reads tracked worktree content, not the index, so this equality is required for it to cover the proposed task commit.
5. Run `bash .agents/skills/no-confidential-names/check.sh` only after the equality check. Newly added files must already be staged so the checker treats their paths as tracked.
6. Use an English Conventional Commit message and commit only when authorized.

If any file changes after its final validation or review, rerun the proportionate checks before committing. Do not amend an existing user commit unless explicitly requested.

## Push safely

Before push, run the confidential-name checker with the relevant base range, normally:

```bash
bash .agents/skills/no-confidential-names/check.sh origin/develop..HEAD
```

Confirm the current branch and upstream, then use a normal non-force push. Stop on divergence, rejection, authentication failure, or an unexpected remote; do not force-push or silently rebase. Verify the pushed commit and report its SHA and branch.

## Build and start at the authorized point

If the requested sequence includes push, finish and verify the push before building. If it requests local build/start without publication, proceed after review and validation without inserting a commit or push.

Before building a published commit, require the tracked worktree and non-ignored untracked set to be clean and `HEAD` to equal the pushed commit. Otherwise repository-local Docker contexts and the build stamp can include unreviewed user changes. Stop and report the conflicting paths; do not stash, clean, or silently bake them. For a local-only build of uncommitted task changes, likewise stop if any unrelated change can enter the build or runtime configuration.

1. Run `make build` when explicitly requested. If it fails, do not start stale images.
2. Run `make up` only when explicitly requested. When build was also requested, run it only after the build succeeds. Keep build and startup separate; `make up` intentionally does not build.
3. Poll `make ps` at short intervals for a bounded convergence window that covers the configured healthcheck start period and retries. Treat `starting` as pending, not failure; stop when every expected service is healthy, any service becomes unhealthy/exits, or the timeout expires.
4. Check the Web UI and the orchestrator's `GET /healthz` with bounded retries using the ports printed or configured by the Makefile. Do not assume default ports when the deployment overrides them.
5. On unhealthy, exit, or timeout, collect bounded recent logs for the affected service, report the evidence, and do not claim success. During a convergence wait longer than 60 seconds, send the user a concise progress update rather than blocking silently.

If only `make up` was requested but the current change is not present in an existing image, explain that a build is required and ask before expanding the endpoint. Do not substitute `make rebuild` for an explicitly requested final `make build` then `make up` sequence.

## Report the handoff

Lead with the outcome and include:

- final review verdict and reviewer independence;
- validation commands and pass/fail counts where available;
- commit SHA, commit subject, pushed branch, and remote result;
- image build result, stack health, and access URL when runtime stages were requested;
- remaining unrelated worktree changes or explicitly unrun gates;
- any user-based evaluation still required before making an HCD claim.

Never claim completion from a green unit suite alone when the requested acceptance, publication, or runtime endpoint has not been reached.
