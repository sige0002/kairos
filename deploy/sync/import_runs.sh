#!/usr/bin/env bash
# =============================================================================
# import_runs.sh — pull COMPLETED recordings from the robot to the recording PC.
#
# In the cross-host (robot-edge) split the recorder writes MCAP on the ROBOT's
# disk. dora_runner (CPU-heavy validation/conversion) runs on the recording PC
# and must read PC-LOCAL copies — NOT the robot's storage over NFS, which would
# make the robot serve disk/network during scans (= loading the robot, the very
# thing the split avoids). This script rsyncs over SSH, ONLY runs that the
# recorder has finalised (a run dir with metadata.yaml), so an in-progress
# recording is never half-copied. The robot-side copy is LEFT IN PLACE (pull is
# a copy, never a move; robot-side retention is a separate concern).
#
# Usage (reads .env.split / .env on the recording PC; override via env):
#     bash deploy/sync/import_runs.sh
#     RUN_ID=run_20260716_120000 bash deploy/sync/import_runs.sh   # one run only
#     ROBOT_SSH=robot@192.168.1.50 ROBOT_DATA_DIR=/home/robot/kairos/data \
#       DATA_DIR=./data BWLIMIT=0 bash deploy/sync/import_runs.sh
#   (or:  make import-runs)
#
# Auth (passwordless, pick ONE — see .env.split.example):
#   ROBOT_SSH_KEY=/abs/path/key   ssh identity file (preferred; BatchMode)
#   ROBOT_SSH_PASSWORD=...        password via sshpass (needs sshpass installed)
#   (neither)                     your ~/.ssh setup as-is (agent / config)
#
# Exit codes: 0 ok, 2 config error, 3 RUN_ID not finalised/found on the robot
# (distinct so the importer sidecar can retry a just-saved run that the
# recorder is still finalising), 4 ssh to the robot failed (auth/network).
#
# Idempotent: a run already present locally with metadata.yaml is skipped. Safe
# to run on a timer (cron/systemd) — rsync --partial --append-verify resumes
# interrupted transfers; the dest run dir only gets metadata.yaml on the final
# pass, so a consumer keying on metadata.yaml never sees a partial import.
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
RUN_ID="${RUN_ID:-}"       # pull only this run (importer save-trigger); else all
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

SRC_RECORDED="$ROBOT_DATA_DIR/recorded"
DST_RECORDED="$DATA_DIR/recorded"
mkdir -p "$DST_RECORDED"
# When run as root (the importer container), keep recorded/ writable by the
# host user / the orchestrator's uid so DELETE /runs and manual cleanup keep
# working — the same 0o777-relax convention as the recorder's run dirs.
[ "$(id -u)" = "0" ] && chmod 0777 "$DST_RECORDED" 2>/dev/null

[ "$QUIET" = "1" ] || echo "import-runs: source $ROBOT_SSH:$SRC_RECORDED  ->  dest $DST_RECORDED  (bwlimit=${BWLIMIT}KB/s)"

# List run dirs on the robot that are FINALISED (contain metadata.yaml). The run
# dir is <recorded>/<run_id>/metadata.yaml; print the run_id. The listing MUST
# distinguish "robot reachable, zero runs" (exit 0) from "ssh failed"
# (auth/network, exit 4) — piping ssh straight into mapfile would swallow the
# failure and let a broken password masquerade as an empty robot.
if ! LISTING="$(
  "${SSH_CMD[@]}" "$ROBOT_SSH" \
    "find '$SRC_RECORDED' -mindepth 2 -maxdepth 2 -name metadata.yaml -printf '%h\n' 2>/dev/null | xargs -r -n1 basename"
)"; then
  echo "import-runs: ssh to $ROBOT_SSH failed (auth or network — see the error above)." >&2
  exit 4
fi
mapfile -t RUNS < <(printf '%s\n' "$LISTING" | sed '/^$/d' | sort -u)

if [ -n "$RUN_ID" ]; then
  # Single-run mode (importer save-trigger): the run must already be finalised.
  found=0
  for run in "${RUNS[@]}"; do
    [ "$run" = "$RUN_ID" ] && found=1
  done
  if [ "$found" -eq 0 ]; then
    echo "import-runs: $RUN_ID is not finalised (or not found) on the robot yet." >&2
    exit 3
  fi
  RUNS=("$RUN_ID")
fi

if [ "${#RUNS[@]}" -eq 0 ]; then
  [ "$QUIET" = "1" ] || echo "import-runs: no finalised runs found on the robot."
  exit 0
fi

RSYNC_OPTS=(-a --partial --append-verify --human-readable -e "${SSH_CMD[*]}")
[ "$BWLIMIT" != "0" ] && RSYNC_OPTS+=(--bwlimit="$BWLIMIT")

imported=0 skipped=0
for run in "${RUNS[@]}"; do
  [ -z "$run" ] && continue
  if [ -f "$DST_RECORDED/$run/metadata.yaml" ]; then
    skipped=$((skipped + 1))
    continue
  fi
  echo "import-runs: pulling $run"
  # Trailing slash on the source copies the run dir's CONTENTS into dest/<run>/.
  # rsync writes data files first; metadata.yaml lands in the same pass, so the
  # presence of metadata.yaml locally is a reliable "fully imported" marker for
  # the next run (and for dora's "completed only" assumption).
  rsync "${RSYNC_OPTS[@]}" "$ROBOT_SSH:$SRC_RECORDED/$run/" "$DST_RECORDED/$run/"
  imported=$((imported + 1))
done

if [ "$QUIET" != "1" ] || [ "$imported" -gt 0 ]; then
  echo "import-runs: done. imported=$imported skipped(already present)=$skipped total_finalised=${#RUNS[@]}"
fi
