#!/usr/bin/env bash
# =============================================================================
# import_runs.sh — pull FINISHED captures from the robot to the recording PC.
#
# In the cross-host (robot-edge) split the recorder writes MCAP on the ROBOT's
# disk. dora_runner (CPU-heavy validation/conversion) runs on the recording PC
# and must read PC-LOCAL copies — NOT the robot's storage over NFS, which would
# make the robot serve disk/network during scans (= loading the robot, the very
# thing the split avoids). This script rsyncs over SSH, ONLY captures the
# recorder has finished, so an in-progress recording is never half-copied. The
# robot-side copy is LEFT IN PLACE (pull is a copy, never a move; robot-side
# retention is a separate concern).
#
# Capture store v2 (contract §10.6): the unit is objects/<capture_id>, and
# "finished" means object_manifest.json declares state completed or
# interrupted. digest_state is deliberately NOT part of the test — the digest
# is the RECEIVING side's job (§11), so waiting for it would deadlock the pull.
#
# Usage (reads .env.split / .env on the recording PC; override via env):
#     bash deploy/sync/import_runs.sh
#     CAPTURE_ID=<uuid7> bash deploy/sync/import_runs.sh    # one capture only
#     ROBOT_SSH=robot@192.168.1.50 ROBOT_DATA_DIR=/home/robot/kairos/data \
#       DATA_DIR=./data BWLIMIT=0 bash deploy/sync/import_runs.sh
#   (or:  make import-runs)
#
# Auth (passwordless, pick ONE — see .env.split.example):
#   ROBOT_SSH_KEY=/abs/path/key   ssh identity file (preferred; BatchMode)
#   ROBOT_SSH_PASSWORD=...        password via sshpass (needs sshpass installed)
#   (neither)                     your ~/.ssh setup as-is (agent / config)
#
# Exit codes: 0 ok, 2 config error, 3 CAPTURE_ID not finished/found on the
# robot (distinct so the importer sidecar can retry a just-saved capture the
# recorder is still finalising), 4 ssh to the robot failed (auth/network).
#
# Idempotent: a capture already present locally with a terminal
# object_manifest.json is skipped. Safe to run on a timer (cron/systemd) —
# rsync --partial --append-verify resumes interrupted transfers.
#
# Partial-import safety: each capture is rsynced into
# $DATA_DIR/.incoming/<capture_id> (which keeps resume state across retries)
# and moved into objects/ with an atomic same-filesystem rename only after
# rsync completes. That upholds contract §2's invariant: an incomplete
# directory under objects/ can only ever be a capture the local recorder is
# writing — never a half-arrived transfer. (rsync does transfer files in
# sorted order, and the hex-named *.mcap shards happen to sort BEFORE
# object_manifest.json — a comment here used to claim the reverse, timing
# sweep D9 — but that ordering is a filename accident, not the safety
# mechanism: the staging dir + rename is, together with the reconciler's
# completeness gate below.)
#
# The orchestrator adopts what lands: its reconciler picks up both a completed
# objects/<capture_id> with no row and a leftover .incoming/<capture_id> whose
# manifest is complete (an importer killed between rsync and the rename). This
# script therefore never needs the orchestrator to be running.
# =============================================================================
set -euo pipefail

# ---- env loading -------------------------------------------------------------
# Load the split env from the repo root as a FALLBACK for variables not already
# set: .env.split (kept beside a single-PC .env, mirroring the Makefile's
# SPLIT_ENV preference) wins over .env. Explicit shell-env overrides keep
# winning — values are captured before sourcing and restored after. Sourcing is
# guarded (set +eu, stderr silenced): env files may assign read-only shell vars
# such as UID, which is harmless here but fatal under `set -eu`.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
_ov_ROBOT_SSH="${ROBOT_SSH:-}"
_ov_ROBOT_DATA_DIR="${ROBOT_DATA_DIR:-}"
_ov_DATA_DIR="${DATA_DIR:-}"
_ov_BWLIMIT="${BWLIMIT:-}"
_ov_ROBOT_SSH_KEY="${ROBOT_SSH_KEY:-}"
_ov_ROBOT_SSH_PASSWORD="${ROBOT_SSH_PASSWORD:-}"
_ov_IMPORT_SSH_OPTS="${IMPORT_SSH_OPTS:-}"
for _env in "$REPO_ROOT/.env.split" "$REPO_ROOT/.env"; do
  if [ -f "$_env" ]; then
    set +eu
    set -a
    # shellcheck disable=SC1090
    . "$_env" 2>/dev/null
    set +a
    set -eu
    break
  fi
done
[ -n "$_ov_ROBOT_SSH" ] && ROBOT_SSH="$_ov_ROBOT_SSH"
[ -n "$_ov_ROBOT_DATA_DIR" ] && ROBOT_DATA_DIR="$_ov_ROBOT_DATA_DIR"
[ -n "$_ov_DATA_DIR" ] && DATA_DIR="$_ov_DATA_DIR"
[ -n "$_ov_BWLIMIT" ] && BWLIMIT="$_ov_BWLIMIT"
[ -n "$_ov_ROBOT_SSH_KEY" ] && ROBOT_SSH_KEY="$_ov_ROBOT_SSH_KEY"
[ -n "$_ov_ROBOT_SSH_PASSWORD" ] && ROBOT_SSH_PASSWORD="$_ov_ROBOT_SSH_PASSWORD"
[ -n "$_ov_IMPORT_SSH_OPTS" ] && IMPORT_SSH_OPTS="$_ov_IMPORT_SSH_OPTS"

ROBOT_SSH="${ROBOT_SSH:-}"
ROBOT_DATA_DIR="${ROBOT_DATA_DIR:-/home/robot/kairos/data}"
DATA_DIR="${DATA_DIR:-./data}"
BWLIMIT="${BWLIMIT:-0}"   # KB/s; 0 = unlimited. Set e.g. 50000 to cap at ~50 MB/s.
ROBOT_SSH_KEY="${ROBOT_SSH_KEY:-}"
ROBOT_SSH_PASSWORD="${ROBOT_SSH_PASSWORD:-}"
IMPORT_SSH_OPTS="${IMPORT_SSH_OPTS:-}"   # extra ssh -o options (importer container)
CAPTURE_ID="${CAPTURE_ID:-}"  # pull only this capture (save-trigger); else all
QUIET="${QUIET:-0}"        # 1: only log pulls/errors (importer sidecar cadence)

if [ -z "$ROBOT_SSH" ]; then
  echo "import-runs: ROBOT_SSH is empty. Set ROBOT_SSH=user@robot-ip (see .env.split.example)." >&2
  exit 2
fi

# ---- ssh command assembly ------------------------------------------------------
# One SSH_CMD array feeds both the finalised-run listing and rsync's -e. Key
# auth (preferred) forces BatchMode so a broken key fails fast instead of
# falling back to an interactive password prompt; password auth wraps ssh in
# sshpass (SSHPASS env, never argv) and forces accept-new because sshpass can
# answer only the password prompt, not a host-key question.
SSH_CMD=(ssh)
if [ -n "$IMPORT_SSH_OPTS" ]; then
  # shellcheck disable=SC2206 - word-splitting the option string is intended.
  SSH_CMD+=($IMPORT_SSH_OPTS)
fi
# Half-open-connection protection, AFTER the operator's own options (ssh takes
# the FIRST value for an option, so anything in IMPORT_SSH_OPTS still wins).
# Without these a dead robot link held the serial worker for the kernel's TCP
# timeout — an hour-plus during which every queued pull sat behind it (S3-1).
SSH_CMD+=(-o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4)
if [ -n "$ROBOT_SSH_KEY" ] && [ -s "$ROBOT_SSH_KEY" ]; then
  SSH_CMD+=(-i "$ROBOT_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes)
elif [ -n "$ROBOT_SSH_PASSWORD" ]; then
  if ! command -v sshpass >/dev/null 2>&1; then
    echo "import-runs: ROBOT_SSH_PASSWORD is set but sshpass is not installed." \
         "Install sshpass (apt install sshpass) or use ROBOT_SSH_KEY instead." >&2
    exit 2
  fi
  export SSHPASS="$ROBOT_SSH_PASSWORD"
  SSH_CMD+=(-o PreferredAuthentications=password -o PubkeyAuthentication=no \
            -o StrictHostKeyChecking=accept-new)
  SSH_CMD=(sshpass -e "${SSH_CMD[@]}")
fi

# capture_id is interpolated into a remote find(1) pattern and into local
# paths, so a malformed one must never reach either. UUIDv7, canonical form.
if [ -n "$CAPTURE_ID" ] && ! printf '%s' "$CAPTURE_ID" | grep -Eq \
    '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'; then
  echo "import-runs: CAPTURE_ID is not a UUIDv7: $CAPTURE_ID" >&2
  exit 2
fi

SRC_OBJECTS="$ROBOT_DATA_DIR/objects"
DST_OBJECTS="$DATA_DIR/objects"
# .incoming is a sibling of objects/ under DATA_DIR (contract §2), NOT a child
# of it: the staging dir must share objects/'s filesystem for the finalize
# rename to be atomic, and must not be visible to anything scanning objects/.
DST_STAGING="$DATA_DIR/.incoming"
mkdir -p "$DST_OBJECTS" "$DST_STAGING"
# When run as root (the importer container), keep both writable by the host
# user / the orchestrator's uid so the delete path and manual cleanup keep
# working — the same 0o777-relax convention as the recorder's capture dirs.
if [ "$(id -u)" = "0" ]; then
  chmod 0777 "$DST_OBJECTS" "$DST_STAGING" 2>/dev/null || true
fi

[ "$QUIET" = "1" ] || echo "import-runs: source $ROBOT_SSH:$SRC_OBJECTS  ->  dest $DST_OBJECTS  (bwlimit=${BWLIMIT}KB/s)"

# List capture dirs on the robot whose manifest declares a terminal state
# (contract §10.6: completed or interrupted; digest_state is not consulted).
# grep -l on the manifest is the whole test — the recorder writes state
# atomically (§3.1), so a manifest naming a terminal state is never a partial
# view of a recording still in progress.
#
# The listing MUST distinguish "robot reachable, zero captures" (exit 0) from
# "ssh failed" (auth/network, exit 4) — piping ssh straight into mapfile would
# swallow the failure and let a broken password masquerade as an empty robot.
REMOTE_FIND="find '$SRC_OBJECTS' -mindepth 2 -maxdepth 2 -name object_manifest.json \
  -exec grep -lE '\"state\"[[:space:]]*:[[:space:]]*\"(completed|interrupted)\"' {} + \
  2>/dev/null | xargs -r -n1 dirname | xargs -r -n1 basename"
if ! LISTING="$("${SSH_CMD[@]}" "$ROBOT_SSH" "$REMOTE_FIND")"; then
  echo "import-runs: ssh to $ROBOT_SSH failed (auth or network — see the error above)." >&2
  exit 4
fi
# Robot-controlled listing: keep only well-formed UUIDv7 names before any of
# them reaches an rsync remote spec (same rule the orchestrator's rebuild
# applies to objects/ directory names). A malformed one must never reach either.
mapfile -t CAPTURES < <(printf '%s\n' "$LISTING" | sed '/^$/d' \
  | grep -Ex '[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}' | sort -u)

if [ -n "$CAPTURE_ID" ]; then
  # Single-capture mode (save-trigger): it must already be finished. Exit 3 is
  # distinct so the sidecar can retry while the recorder is still finalising.
  found=0
  for capture in "${CAPTURES[@]}"; do
    [ "$capture" = "$CAPTURE_ID" ] && found=1
  done
  if [ "$found" -eq 0 ]; then
    echo "import-runs: $CAPTURE_ID is not finished (or not found) on the robot yet." >&2
    exit 3
  fi
  CAPTURES=("$CAPTURE_ID")
fi

if [ "${#CAPTURES[@]}" -eq 0 ]; then
  [ "$QUIET" = "1" ] || echo "import-runs: no finished captures found on the robot."
  exit 0
fi

RSYNC_OPTS=(-a --partial --append-verify --human-readable --timeout=60 \
            -e "${SSH_CMD[*]}")
[ "$BWLIMIT" != "0" ] && RSYNC_OPTS+=(--bwlimit="$BWLIMIT")

# A capture is already here if its manifest is at the FINAL path with a
# terminal state — the same test applied to the robot side, so both ends agree
# on what "finished" means and a re-run is a no-op rather than a re-transfer.
is_complete_locally() {
  local dir="$1/object_manifest.json"
  [ -f "$dir" ] || return 1
  grep -qE '"state"[[:space:]]*:[[:space:]]*"(completed|interrupted)"' "$dir"
}

# Deleted-here means deleted, even for a re-pull (timing sweep S4). Local
# deletion is a ledger tombstone + the bytes leaving objects/ — so an
# `{"all": true}` pull used to see the capture "missing" and faithfully fetch
# it back from the robot, resurrecting what the operator removed (the robot
# keeps its copy until drop-local exists, contract §13). The ledger is the
# durable record and deletion is permanent (no restore), so a tombstoned
# capture is skipped forever. Byte-grep is deliberate: the ledger is written
# by one canonical writer (ledger_v2) with stable JSON formatting.
is_tombstoned_locally() {
  local id="$1" ledger="$DATA_DIR/lifecycle.jsonl"
  [ -f "$ledger" ] || return 1
  grep -F "\"capture_id\": \"$id\"" "$ledger" \
    | grep -qE '"kind": "capture_(discarded|deleted)"'
}

imported=0 skipped=0 skipped_deleted=0
for capture in "${CAPTURES[@]}"; do
  [ -z "$capture" ] && continue
  if is_complete_locally "$DST_OBJECTS/$capture"; then
    skipped=$((skipped + 1))
    continue
  fi
  if is_tombstoned_locally "$capture"; then
    skipped_deleted=$((skipped_deleted + 1))
    continue
  fi
  echo "import-runs: pulling $capture"
  # A dir under objects/ WITHOUT a terminal manifest is either a half-arrived
  # transfer from an older version of this script or a local recording — and a
  # pull only ever runs on the recording PC, which has no local recorder. Fold
  # it into staging so the transfer resumes rather than staying stuck.
  if [ -d "$DST_OBJECTS/$capture" ] && [ ! -d "$DST_STAGING/$capture" ]; then
    mv "$DST_OBJECTS/$capture" "$DST_STAGING/$capture"
  fi
  # Trailing slash copies the capture dir's CONTENTS into staging. An
  # interrupted transfer stays in .incoming (with rsync resume state); only a
  # completed rsync is moved into the consumer-visible path.
  rsync "${RSYNC_OPTS[@]}" "$ROBOT_SSH:$SRC_OBJECTS/$capture/" "$DST_STAGING/$capture/"
  # Verify what actually landed before publishing it. rsync exiting 0 is not
  # the same claim: a source whose manifest changed mid-transfer, or a partial
  # dir folded in above, could leave staging without a terminal manifest — and
  # moving that into objects/ would break §2's invariant.
  if ! is_complete_locally "$DST_STAGING/$capture"; then
    echo "import-runs: $capture arrived without a terminal manifest; left in .incoming" >&2
    continue
  fi
  if [ -d "$DST_OBJECTS/$capture" ]; then
    # Raced by another importer (or the orchestrator's adopt pass) that
    # finished first: keep the copy that is already published.
    rm -rf "$DST_STAGING/$capture"
  else
    mv "$DST_STAGING/$capture" "$DST_OBJECTS/$capture"
  fi
  # Sibling sidecars ride along (timing sweep S4): objects/<id>.qos.yaml is
  # the record of the QoS the recorder actually applied, and without it the
  # pulled copy can only answer "what QoS was this recorded with?" on the
  # robot. Best-effort — an older robot may not have written one, and a
  # missing sidecar must not fail the pull that just landed the bytes.
  rsync "${RSYNC_OPTS[@]}" \
    "$ROBOT_SSH:$SRC_OBJECTS/$capture.qos.yaml" \
    "$DST_OBJECTS/$capture.qos.yaml" 2>/dev/null || true
  imported=$((imported + 1))
done

if [ "$QUIET" != "1" ] || [ "$imported" -gt 0 ]; then
  echo "import-runs: done. imported=$imported skipped(already present)=$skipped skipped(deleted here)=$skipped_deleted total_finished=${#CAPTURES[@]}"
fi
