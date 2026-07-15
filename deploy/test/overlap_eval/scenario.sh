#!/usr/bin/env bash
# One overlap-eval scenario: replay the sample bag fresh, record RECORD_S
# seconds via the live stack, optionally hammer a concurrent rsync pull.
# Usage: scenario.sh NAME MODE
#   NAME: label (A/B/C...)   MODE: none | 0 (rsync unlimited) | <KB/s> (bwlimit)
# See README.md for the protocol and the knobs.
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
NAME="$1"; MODE="$2"
ORCH="${ORCH:-http://localhost:8000}"
BAG="${BAG:-airoa-moma-mcap/064423}"
RECORD_S="${RECORD_S:-120}"
OUT_DIR="${OUT_DIR:-/tmp/kairos_overlap_eval}"
mkdir -p "$OUT_DIR"
export OUT_DIR
cd "$REPO_ROOT"

cleanup() {
  [ -n "${RSYNC_PID:-}" ] && kill "$RSYNC_PID" 2>/dev/null && pkill -P "$RSYNC_PID" 2>/dev/null
  [ -n "${SAMPLER_PID:-}" ] && kill "$SAMPLER_PID" 2>/dev/null
  [ -n "${CID:-}" ] && docker stop -t 2 "$CID" >/dev/null 2>&1
  pkill -f "rsync.*$OUT_DIR/rsync_dest" 2>/dev/null
  true
}
trap cleanup EXIT

echo "=== scenario $NAME (mode=$MODE, bag=$BAG, ${RECORD_S}s) ==="
# Fresh replay each scenario -> the record window covers the SAME bag segment
# every time (pick a bag longer than RECORD_S so no loop restart lands inside).
CID=$(BAG="$BAG" LOOP=--loop \
  docker compose -f deploy/test/compose.yaml run -d --rm rosbag_player | tail -1)
echo "replay container: $CID"
sleep 8

bash "$SCRIPT_DIR/sampler.sh" "$OUT_DIR/sample_$NAME.log" &
SAMPLER_PID=$!

if [ "$MODE" != "none" ]; then
  bash "$SCRIPT_DIR/rsync_loop.sh" "$MODE" "$OUT_DIR/rsync_$NAME.log" &
  RSYNC_PID=$!
  sleep 2   # let the first pass ramp up before recording starts
fi

START=$(curl -fsS --max-time 5 -X POST "$ORCH/api/v1/record/start" \
  -H 'content-type: application/json' -d '{"topics":"all"}')
RUN_ID=$(printf '%s' "$START" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("run_id",""))')
echo "recording: $RUN_ID"
[ -z "$RUN_ID" ] && { echo "START FAILED: $START"; exit 1; }

sleep "$RECORD_S"
curl -fsS --max-time 10 -X POST "$ORCH/api/v1/record/stop" -d '{}' >/dev/null
sleep 6

echo "$RUN_ID" > "$OUT_DIR/run_$NAME.txt"
echo "=== scenario $NAME done: $RUN_ID ==="
