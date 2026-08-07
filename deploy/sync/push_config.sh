#!/usr/bin/env bash
# =============================================================================
# push_config.sh — publish this PC's config/local/<ROBOT>/ to the robot.
#
# In the cross-host (robot-edge) split the recorder/monitor read their config
# from the ROBOT's repo clone. Committed robots (config/<robot>/) travel with
# git, but user robots live in the GITIGNORED config/local/<robot>/ tree — a
# fresh clone on the robot simply does not have them. This script rsyncs the
# recording PC's config/local/<ROBOT>/ into the robot's clone so the robot-edge
# services resolve the same robot config the PC's Config tab shows.
#
# Direction is one-way (PC -> robot): when you use this tool, the PC copy is
# the source of truth. Files deleted locally are NOT deleted on the robot
# unless DELETE=1 (protects robot-side hand edits from silent removal).
#
# Usage (reads .env.split / .env on the recording PC; override via env):
#     bash deploy/sync/push_config.sh
#     ROBOT=myrobot ROBOT_SSH=robot@192.168.1.50 bash deploy/sync/push_config.sh
#   (or:  make push-config)
#
# Auth: same as import_runs.sh — ROBOT_SSH_KEY (identity file, preferred) or
# ROBOT_SSH_PASSWORD (sshpass), else your ~/.ssh setup as-is.
#
# After pushing, apply on the robot:  make robot-config-reload
# =============================================================================
set -euo pipefail

# Load the split env from the repo root as a FALLBACK for variables not already
# set: .env.split wins over .env (mirrors the Makefile's SPLIT_ENV preference);
# explicit shell-env overrides keep winning. Guarded sourcing: env files may
# assign read-only shell vars such as UID — fatal under `set -eu` otherwise.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
_ov_ROBOT="${ROBOT:-}"
_ov_ROBOT_SSH="${ROBOT_SSH:-}"
_ov_ROBOT_DATA_DIR="${ROBOT_DATA_DIR:-}"
_ov_ROBOT_KAIROS_DIR="${ROBOT_KAIROS_DIR:-}"
_ov_ROBOT_SSH_KEY="${ROBOT_SSH_KEY:-}"
_ov_ROBOT_SSH_PASSWORD="${ROBOT_SSH_PASSWORD:-}"
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
[ -n "$_ov_ROBOT" ] && ROBOT="$_ov_ROBOT"
[ -n "$_ov_ROBOT_SSH" ] && ROBOT_SSH="$_ov_ROBOT_SSH"
[ -n "$_ov_ROBOT_DATA_DIR" ] && ROBOT_DATA_DIR="$_ov_ROBOT_DATA_DIR"
[ -n "$_ov_ROBOT_KAIROS_DIR" ] && ROBOT_KAIROS_DIR="$_ov_ROBOT_KAIROS_DIR"
[ -n "$_ov_ROBOT_SSH_KEY" ] && ROBOT_SSH_KEY="$_ov_ROBOT_SSH_KEY"
[ -n "$_ov_ROBOT_SSH_PASSWORD" ] && ROBOT_SSH_PASSWORD="$_ov_ROBOT_SSH_PASSWORD"

ROBOT="${ROBOT:-airoa_hsr}"
ROBOT_SSH="${ROBOT_SSH:-}"
ROBOT_DATA_DIR="${ROBOT_DATA_DIR:-/home/robot/kairos/data}"
ROBOT_SSH_KEY="${ROBOT_SSH_KEY:-}"
ROBOT_SSH_PASSWORD="${ROBOT_SSH_PASSWORD:-}"
DELETE="${DELETE:-0}"   # DELETE=1 also removes robot-side files absent locally.

# Passwordless auth (same policy as import_runs.sh): key file preferred
# (BatchMode = fail fast, no interactive fallback); else sshpass with the
# password from env (accept-new because sshpass can only answer the password
# prompt, not a host-key question); else the caller's ~/.ssh setup as-is.
SSH_CMD=(ssh)
if [ -n "$ROBOT_SSH_KEY" ] && [ -s "$ROBOT_SSH_KEY" ]; then
  SSH_CMD+=(-i "$ROBOT_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes)
elif [ -n "$ROBOT_SSH_PASSWORD" ]; then
  if ! command -v sshpass >/dev/null 2>&1; then
    echo "push-config: ROBOT_SSH_PASSWORD is set but sshpass is not installed." \
         "Install sshpass (apt install sshpass) or use ROBOT_SSH_KEY instead." >&2
    exit 2
  fi
  export SSHPASS="$ROBOT_SSH_PASSWORD"
  SSH_CMD+=(-o PreferredAuthentications=password -o PubkeyAuthentication=no \
            -o StrictHostKeyChecking=accept-new)
  SSH_CMD=(sshpass -e "${SSH_CMD[@]}")
fi

if [ -z "$ROBOT_SSH" ]; then
  echo "push-config: ROBOT_SSH is empty. Set ROBOT_SSH=user@robot-ip (see .env.split.example)." >&2
  exit 2
fi

# The robot's repo root: explicit ROBOT_KAIROS_DIR, else derived from
# ROBOT_DATA_DIR (the repo's ./data by convention).
ROBOT_KAIROS_DIR="${ROBOT_KAIROS_DIR:-}"
if [ -z "$ROBOT_KAIROS_DIR" ]; then
  case "$ROBOT_DATA_DIR" in
    */data) ROBOT_KAIROS_DIR="${ROBOT_DATA_DIR%/data}" ;;
    *)
      echo "push-config: cannot derive the robot repo dir from ROBOT_DATA_DIR=$ROBOT_DATA_DIR;" >&2
      echo "             set ROBOT_KAIROS_DIR=/path/to/kairos on the robot." >&2
      exit 2
      ;;
  esac
fi

SRC="$REPO_ROOT/config/local/$ROBOT"
DST="$ROBOT_KAIROS_DIR/config/local/$ROBOT"

if [ ! -d "$SRC" ]; then
  echo "push-config: $SRC does not exist — nothing to push for ROBOT=$ROBOT." >&2
  echo "             (committed robots under config/<robot>/ travel with git; only" >&2
  echo "             the gitignored config/local/<robot>/ tree needs pushing.)" >&2
  exit 2
fi

RSYNC_OPTS=(-a --human-readable -e "${SSH_CMD[*]}")
[ "$DELETE" = "1" ] && RSYNC_OPTS+=(--delete)

echo "push-config: $SRC/  ->  $ROBOT_SSH:$DST/ (delete=$DELETE)"
"${SSH_CMD[@]}" "$ROBOT_SSH" "mkdir -p '$DST'"
rsync "${RSYNC_OPTS[@]}" "$SRC/" "$ROBOT_SSH:$DST/"
echo "push-config: done. Apply on the robot with: make robot-config-reload"
