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
# recording is never half-copied.
#
# Usage (reads .env on the recording PC; override via env):
#     bash deploy/sync/import_runs.sh
#     ROBOT_SSH=robot@192.168.1.50 ROBOT_DATA_DIR=/home/robot/kairos/data \
#       DATA_DIR=./data BWLIMIT=0 bash deploy/sync/import_runs.sh
#   (or:  make import-runs)
#
# Idempotent: a run already present locally with metadata.yaml is skipped. Safe
# to run on a timer (cron/systemd) — rsync --partial --append-verify resumes
# interrupted transfers; the dest run dir only gets metadata.yaml on the final
# pass, so a consumer keying on metadata.yaml never sees a partial import.
# =============================================================================
set -euo pipefail

# Load .env from the repo root if present (so ROBOT_SSH etc. are picked up).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
if [ -f "$REPO_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO_ROOT/.env"
  set +a
fi

ROBOT_SSH="${ROBOT_SSH:-}"
ROBOT_DATA_DIR="${ROBOT_DATA_DIR:-/home/robot/kairos/data}"
DATA_DIR="${DATA_DIR:-./data}"
BWLIMIT="${BWLIMIT:-0}"   # KB/s; 0 = unlimited. Set e.g. 50000 to cap at ~50 MB/s.

if [ -z "$ROBOT_SSH" ]; then
  echo "import-runs: ROBOT_SSH is empty. Set ROBOT_SSH=user@robot-ip (see .env.split.example)." >&2
  exit 2
fi

SRC_RECORDED="$ROBOT_DATA_DIR/recorded"
DST_RECORDED="$DATA_DIR/recorded"
mkdir -p "$DST_RECORDED"

echo "import-runs: source $ROBOT_SSH:$SRC_RECORDED  ->  dest $DST_RECORDED  (bwlimit=${BWLIMIT}KB/s)"

# List run dirs on the robot that are FINALISED (contain metadata.yaml). The run
# dir is <recorded>/<run_id>/metadata.yaml; print the run_id.
mapfile -t RUNS < <(
  ssh "$ROBOT_SSH" \
    "find '$SRC_RECORDED' -mindepth 2 -maxdepth 2 -name metadata.yaml -printf '%h\n' 2>/dev/null | xargs -r -n1 basename" \
    | sort -u
)

if [ "${#RUNS[@]}" -eq 0 ]; then
  echo "import-runs: no finalised runs found on the robot."
  exit 0
fi

RSYNC_OPTS=(-a --partial --append-verify --human-readable)
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

echo "import-runs: done. imported=$imported skipped(already present)=$skipped total_finalised=${#RUNS[@]}"
