---
name: review-publish-run
description: Complete an explicitly requested review plus commit, push, image build, or stack start in kairos. Stop at the requested endpoint; ordinary review does not authorize publication.
---

# Review, publish, and run

Finish through the user's requested endpoint. A commit request authorizes a local commit; push, PR, merge, build, and startup each need authorization from the request or existing session. Honor already granted authority without asking again. Issue creation belongs to `github-issue-pr` when explicitly asked.

## Scope and evidence

Inspect task-owned staged and untracked changes; preserve unrelated work. If the index contains unrelated changes, do not include or unstage them; resolve that boundary before committing.

Choose gates from AGENTS.md, Makefile, manifests, and CI:

- Python changes need affected package tests and relevant Ruff / format checks; use `make test-py` when crossing package boundaries.
- UI or behavior changes need `make test-fe`, builds of every affected service image, then `make test-e2e` and changed browser states. These prerequisites do not authorize persistent `make up`. If they are unavailable or prohibited, report the blocked gate before publication.
- Use the relevant ROS, Compose, and data checks for those changes. Sync Japanese canonical docs to English mirrors. Instruction-only changes need documentation checks, not application builds.

Required gate failures or missing evidence block commit/publication. Reuse evidence only for the same final state; after a fix or integration change, rerun affected gates. A dirty-worktree pass does not prove an isolated task commit; use a clean temporary worktree when unrelated changes could affect it, or report that limitation.

## Review

For a requested review, use an independent read-only agent when available. Give it the brief, complete task diff, and evidence without steering the verdict. Require severity-ordered findings with file/line, concrete failure scenario, verified versus conjectured status, and `PASS` or `FAIL`.

Fix actionable findings, validate affected behavior, and request a focused recheck. Do not publish with unresolved blocking findings. If independence is unavailable, perform and label a self-review.

## Commit and push

For an authorized commit:

1. Inspect the final task diff and run `git diff --check`.
2. Stage only task-owned paths; inspect the complete staged diff and ensure staged paths have no unstaged layer.
3. Include authorized new files in staging, then apply [no-confidential-names](../no-confidential-names/SKILL.md), including the proposed English Conventional Commit message.
4. Commit only after the relevant gates and review still match the final state.

Before an authorized push, check confidential names against the relevant base range, branch, remote, and upstream. Use a normal non-force push and verify the pushed SHA. For divergence or rejection, fetch and integrate deliberately; do not force-push. For a Git authentication failure, distinguish it from `gh` authentication and report the remote permission or access issue after one supported credential-path retry.

## Build and start

Follow the requested order. Before building a published commit, require HEAD to match the pushed SHA and ensure unrelated content cannot enter Docker contexts or runtime configuration. Do not stash or clean user work.

`make build` and `make up` are separate stages. If a requested build fails, do not start stale images. After an authorized start, poll `make ps` within the healthcheck window, verify required service health plus UI and orchestrator `/healthz`, and collect bounded recent logs on failure. Release only resources owned by this workflow.

Report review independence, relevant gate results, completed commit/push/runtime stages, and remaining blockers.
