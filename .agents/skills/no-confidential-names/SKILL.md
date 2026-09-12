---
name: no-confidential-names
description: Keep confidential robot names out of kairos tracked files and public text. Use for robot-identifying edits and before commit, push, PR, or merge.
---

# No confidential names

Kairos is public. Tracked files, commit messages, and published issue/PR text
must not identify a confidential robot. Keep real names and topic lists in
`config/local/<robot>/`, `deploy/msgs_overlay/<robot>/`, and `.env` (`ROBOT`).
Tracked content uses `ROBOT`, `<robot>` in prose/paths, and `myrobot` / `MYROBOT`
in fixtures and identifiers. Do not store a deny-list in this tracked skill.

## Check the intended surface

From the repository root:

```bash
bash .agents/skills/no-confidential-names/check.sh
bash .agents/skills/no-confidential-names/check.sh origin/develop..HEAD
```

The script derives names from gitignored directories across all registered
worktrees. The first command scans the tracked working tree. A supplied range
also scans commit messages and added diff lines; use the relevant base range
before publication because a clean tree does not prove clean history.
Exit `0` is clean, `1` is a finding, and `2` is an error.

The checker reads working-tree content, not staged blobs. For an authorized
commit, stage task-owned new files first and ensure task-owned staged paths
have no additional unstaged layer. Inspect branch names, issue/PR text, and
proposed commit messages separately; they may not yet exist in the scanned
surfaces. A successful check covers only the surfaces it actually inspected.

## Resolve a finding

Rename identifying fixtures without deleting their tests. Move real deployment
values into gitignored robot configuration. A generic topic is fine; labeling
a topic set as belonging to a confidential robot is identifying information.
Rerun the check and tests affected by any code/fixture rename; prose-only
redaction does not require the application suites.

`ALLOW` in `check.sh` records deliberately public scaffold/sample/product names.
Do not extend it just to silence a finding. A justified public-name exception
needs an explanation in the authorized change.

If a name was already pushed, removing current text does not erase old blobs
or messages. Report the exposure without repeating the name in public text.
History rewriting and force-push require the user's decision; do not perform
them as an automatic cleanup.
