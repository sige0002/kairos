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
# Usage (reads .env on the recording PC; override via env):
#     bash deploy/sync/push_config.sh
#     ROBOT=myrobot ROBOT_SSH=robot@192.168.1.50 bash deploy/sync/push_config.sh
#   (or:  make push-config)
#
# After pushing, apply on the robot:  make robot-config-reload
# =============================================================================
set -euo pipefail

# Load .env from the repo root if present (so ROBOT / ROBOT_SSH are picked up).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
if [ -f "$REPO_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO_ROOT/.env"
  set +a
fi

ROBOT="${ROBOT:-airoa_hsr}"
ROBOT_SSH="${ROBOT_SSH:-}"
ROBOT_DATA_DIR="${ROBOT_DATA_DIR:-/home/robot/kairos/data}"
DELETE="${DELETE:-0}"   # DELETE=1 also removes robot-side files absent locally.

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

RSYNC_OPTS=(-a --human-readable)
[ "$DELETE" = "1" ] && RSYNC_OPTS+=(--delete)

echo "push-config: $SRC/  ->  $ROBOT_SSH:$DST/ (delete=$DELETE)"
ssh "$ROBOT_SSH" "mkdir -p '$DST'"
rsync "${RSYNC_OPTS[@]}" "$SRC/" "$ROBOT_SSH:$DST/"
echo "push-config: done. Apply on the robot with: make robot-config-reload"
