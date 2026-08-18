#!/usr/bin/env bash
# Scan for confidential names that must not reach a tracked file or a commit
# message. See SKILL.md.
#
#   bash .agents/skills/no-confidential-names/check.sh                 # tree only
#   bash .agents/skills/no-confidential-names/check.sh origin/develop..HEAD
#
# The name list is DERIVED at runtime from gitignored locations, never stored
# here — this file is tracked, so a hardcoded list would be the very leak the
# check exists to prevent.
#
# Exit 0 = clean, 1 = hits found, 2 = usage/environment error.

set -uo pipefail

RANGE="${1:-}"
cd "$(git rev-parse --show-toplevel 2>/dev/null)" || {
	echo "not a git repository" >&2
	exit 2
}

DIFF_RANGE=""
DIFF_TEXT=""
if [ -n "$RANGE" ]; then
	if ! git rev-list "$RANGE" >/dev/null 2>&1; then
		echo "invalid git revision range: $RANGE" >&2
		exit 2
	fi
	DIFF_RANGE=$RANGE
	if ! DIFF_TEXT=$(git diff "$DIFF_RANGE"); then
		echo "failed to read git diff for range: $DIFF_RANGE" >&2
		exit 2
	fi
fi

# Names that ARE deliberately committed: the scaffold names, the public sample
# robot, and public third-party product names. This list is a record of judgment
# calls — revisit it when adding a robot, don't grow it to silence a finding.
ALLOW='^(robot|template|airoa_hsr|isaac_sim|myrobot)$'

# --- derive the candidate names ---------------------------------------------
# A confidential robot is registered exactly two ways, both gitignored:
# a config set (config/local/<robot>/, one DIRECTORY per robot — see that
# README) and an optional message overlay (deploy/msgs_overlay/<robot>/). The
# active one also appears as ROBOT in .env.
#
# Deliberately NOT a source: data/. Its subdirectories are runtime output
# (operator/task export destinations, sample bags), so deriving from it floods
# the scan with names that are not robots at all.
candidates() {
	{
		# Linked worktrees usually lack gitignored local configuration. Derive
		# candidates from every checkout of this repository so the gate works
		# from either the main checkout or a task worktree.
		git worktree list --porcelain |
			sed -n 's/^worktree //p' |
			while IFS= read -r root; do
				find "$root/config/local" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null
				find "$root/deploy/msgs_overlay" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null
				# \042 and \047 strip quotes around ROBOT values.
				sed -n 's/^[[:space:]]*ROBOT=[[:space:]]*//p' "$root/.env" 2>/dev/null |
					tr -d '\042\047'
			done
	} |
		tr '[:upper:]' '[:lower:]' |
		grep -vE "$ALLOW" |
		# 4+ chars: shorter tokens match too much to be a useful signal.
		grep -E '^[a-z0-9][a-z0-9_-]{3,}$' |
		sort -u
}

NAMES=$(candidates)
if [ -z "$NAMES" ]; then
	echo "no candidate names derived (nothing gitignored to protect) — nothing to check"
	exit 0
fi
echo "checking $(echo "$NAMES" | wc -l) derived name(s)"

hits=0

# --- 1. tracked tree ---------------------------------------------------------
while IFS= read -r name; do
	found=$(git grep -i -n -- "$name" -- . 2>/dev/null)
	if [ -n "$found" ]; then
		echo
		echo "TRACKED FILES contain '$name':"
		echo "$found" | head -30
		hits=1
	fi
done <<<"$NAMES"

# --- 2 + 3. commit messages and added lines in the range ---------------------
if [ -n "$RANGE" ]; then
	while IFS= read -r name; do
		if ! msgs=$(git log -i --grep="$name" --format='%h %s' "$RANGE"); then
			echo "failed to read git log for range: $RANGE" >&2
			exit 2
		fi
		if [ -n "$msgs" ]; then
			echo
			echo "COMMIT MESSAGES in $RANGE mention '$name':"
			echo "$msgs"
			hits=1
		fi
		added=$(printf '%s\n' "$DIFF_TEXT" | grep -i "^+.*$name" | head -30)
		if [ -n "$added" ]; then
			echo
			echo "ADDED LINES in $DIFF_RANGE contain '$name':"
			echo "$added"
			hits=1
		fi
	done <<<"$NAMES"
fi

echo
if [ "$hits" -eq 0 ]; then
	echo "PASS — no confidential name in tracked files${RANGE:+, commit messages, or the diff}"
else
	echo "FAIL — see above. Fix per SKILL.md: <robot> in prose, myrobot in fixtures,"
	echo "real values in gitignored config/local/<robot>/ selected by ROBOT."
fi
exit "$hits"
