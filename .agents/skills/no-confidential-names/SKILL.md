---
name: no-confidential-names
description: Keep a confidential robot's name out of tracked files and commit messages in kairos. Use when editing anything tracked that names a robot (test fixtures, config defaults, docs examples, Makefile variables), when writing a commit message, and as a gate before commit, push, opening a PR, or merging one. Protected names are derived at runtime from gitignored robot-specific config and message-overlay directories; this skill never stores a name itself.
---

# No confidential names in tracked files

## The policy

No tracked (non-gitignored) file, and no commit message, carries a specific
robot's name. Real names and topic lists live only in gitignored places:

| Where | What |
| --- | --- |
| `config/local/<robot>/` | that robot's recording / stream / validation / validators YAML |
| `deploy/msgs_overlay/<robot>/` | its proprietary message packages |
| `.env` | `ROBOT=<robot>` — which set is active |

Tracked files address a robot only through the **indirection**: `ROBOT`,
`<robot>` in a path, a placeholder in prose. Established by commit `bfdf15a`.

**The repository is public.** A name that reaches a commit is published the
moment it is pushed.

## Why this file names no robot

`.agents/skills/` is tracked. A hardcoded deny-list here would be the exact leak
the check exists to prevent. So `check.sh` **derives** the list at runtime from
the gitignored directories above in every checkout reported by `git worktree
list`. The same gate therefore works inside a linked worktree with no local
configuration of its own.

## Run the check

```bash
bash .agents/skills/no-confidential-names/check.sh                    # tracked tree only
bash .agents/skills/no-confidential-names/check.sh origin/develop..HEAD   # + messages + diff
```

Pass a range whenever one exists — the tree can be clean while a commit message
in the range still carries the name. Exit `0` = clean, `1` = hits, `2` = error.

It scans three surfaces, because a name reaches the public through any of them:

1. **the tracked tree** — `git grep` over tracked files
2. **commit messages** in the range
3. **added lines** in the range's diff

## Fixing a hit

Rename, never delete the test. Follow the convention already in the tree:

| Context | Use |
| --- | --- |
| prose, comments, docs, path examples | `<robot>` placeholder |
| test fixtures, identifiers, ids | `myrobot` / `MYROBOT` |
| a real config value | move it to `config/local/<robot>/`, select via `ROBOT` |

Topic names count too: a generic topic string is fine, but do not label a set as
belonging to a named robot — the label is what identifies it.

Re-run the check, then the affected suites (`uv run --extra test pytest -q`,
`npm test`) — these are renames, so tests must stay green, not be adjusted.

## Adding a robot

Nothing to do here: drop its config under `config/local/<robot>/` and the check
picks the name up on the next run.

The one knob is `ALLOW` in `check.sh` — names that ARE deliberately committed
(the scaffold names, the public sample robot, public third-party product names).
It is a record of judgment calls. **Do not add a name to it to silence a
finding**; add one only when the name is genuinely public and belongs in the
repo, and say why in the commit message.

## What this cannot do

It stops a name from reaching a commit. It does **not** remove one already
pushed: the old blobs and messages stay in the public history. If the check
fires on something already on a public branch, say so plainly — removing it
needs history rewriting (force-push), which is the user's call, not a fix you
apply on your own.
