#!/usr/bin/env bash
# End-to-end smoke test for a running kairos stack — prints clear PASS/FAIL so a
# "did it actually work?" check produces visible output (not silence).
#
# It plays a sample bag onto the ROS 2 graph and verifies, through the public
# api_orchestrator API, that:
#   1. the orchestrator is healthy,
#   2. GET /api/v1/config exposes the configured default_topics (UI wiring),
#   3. GET /api/v1/topics discovers the replayed topics (graph visibility),
#   4. the monitor is actually measuring topics (live Hz) — with an actionable
#      hint when it measures 0 (the classic RECORDING_CONFIG mismatch).
#
# Prerequisites: the stack is up (`docker compose up`) and a sample bag exists
# under data/ (see CLAUDE.md). Run from the repo root:
#
#   bash deploy/test/smoke.sh
#   BAG=/data/airoa-moma-mcap/000730 bash deploy/test/smoke.sh
#   RECORD=1 bash deploy/test/smoke.sh        # also exercise record start/stop
#
set -uo pipefail

ORCH="${ORCH:-http://localhost:8000}"
MON="${MON:-http://localhost:8001}"
BAG="${BAG:-/data/airoa-moma-mcap/235210}"
COMPOSE_TEST="deploy/test/compose.yaml"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$HERE"

pass=0
fail=0
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail + 1)); }
info() { printf '  \033[36m·\033[0m    %s\n' "$1"; }
hd()   { printf '\n\033[1m%s\033[0m\n' "$1"; }

# Extract a value from JSON on stdin via python3 (no jq dependency).
jq_py() { python3 -c "$1"; }

PLAYER_ID=""
cleanup() {
  if [ -n "$PLAYER_ID" ]; then docker rm -f "$PLAYER_ID" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

# ---- 1. orchestrator health -------------------------------------------------
hd "1. api_orchestrator health"
health="$(curl -fsS --max-time 5 "$ORCH/healthz" 2>/dev/null)"
if printf '%s' "$health" | grep -q '"status"\s*:\s*"ok"'; then
  ok "GET /healthz -> ok"
else
  bad "GET /healthz unreachable (is the stack up? docker compose up)"
  hd "Summary: $pass passed, $fail failed"; exit 1
fi

# ---- 2. config wiring (default_topics) --------------------------------------
hd "2. GET /api/v1/config exposes configured topics"
cfg="$(curl -fsS --max-time 5 "$ORCH/api/v1/config" 2>/dev/null)"
robot="$(printf '%s' "$cfg" | jq_py 'import sys,json;print(json.load(sys.stdin)["defaults"].get("robot_name","(none)"))' 2>/dev/null)"
ndef="$(printf '%s' "$cfg" | jq_py 'import sys,json;print(len(json.load(sys.stdin)["defaults"].get("default_topics",[])))' 2>/dev/null)"
info "robot_name=${robot}  default_topics=${ndef}"
if [ "${ndef:-0}" -gt 0 ]; then
  ok "config exposes ${ndef} default_topics (Record/Monitor tabs are wired)"
else
  bad "default_topics is empty — set RECORDING_CONFIG to a valid file (see config/README.md)"
fi

# ---- 3. start replay + graph discovery --------------------------------------
hd "3. replay sample bag and discover topics"
info "playing (loop) ${BAG}"
PLAYER_ID="$(LOOP=--loop BAG="$BAG" docker compose -f "$COMPOSE_TEST" run --rm -d rosbag_player 2>/dev/null)"
if [ -z "$PLAYER_ID" ]; then
  bad "could not start rosbag_player (docker/compose available? bag exists?)"
else
  info "player container ${PLAYER_ID:0:12}"
fi

ntopics=0
for _ in $(seq 1 20); do
  ntopics="$(curl -fsS --max-time 5 "$ORCH/api/v1/topics" 2>/dev/null \
    | jq_py 'import sys,json;print(len(json.load(sys.stdin).get("topics",[])))' 2>/dev/null || echo 0)"
  if [ "${ntopics:-0}" -gt 3 ]; then break; fi
  sleep 1
done
if [ "${ntopics:-0}" -gt 3 ]; then
  ok "GET /api/v1/topics discovered ${ntopics} topics on the graph"
  curl -fsS --max-time 5 "$ORCH/api/v1/topics" 2>/dev/null \
    | jq_py 'import sys,json
for t in sorted(json.load(sys.stdin).get("topics",[]), key=lambda x:x["name"])[:8]:
    print("       ", t["name"], "pub="+str(t.get("publisher_count")))' 2>/dev/null
else
  bad "only ${ntopics} topics discovered — replay not reaching the graph (ROS_DOMAIN_ID / DDS?)"
fi

# ---- 4. monitor is measuring live Hz ----------------------------------------
hd "4. topic_monitor live metrics"
nmetrics=0
for _ in $(seq 1 10); do
  nmetrics="$(curl -fsS --max-time 5 "$MON/metrics" 2>/dev/null \
    | jq_py 'import sys,json;print(len(json.load(sys.stdin).get("topics",[])))' 2>/dev/null || echo 0)"
  if [ "${nmetrics:-0}" -gt 0 ]; then break; fi
  sleep 1
done
if [ "${nmetrics:-0}" -gt 0 ]; then
  ok "monitor is measuring ${nmetrics} topics (live Hz available)"
else
  bad "monitor measured 0 topics."
  info "Hint: its RECORDING_CONFIG default_topics don't match the bag (or the path"
  info "is invalid). For the HSR sample set RECORDING_CONFIG=/config/airoa_hsr/recording/default.yaml"
  info "and recreate: docker compose up -d --force-recreate monitor   (see config/README.md)"
fi

# ---- 5. optional: record start/stop -----------------------------------------
if [ "${RECORD:-0}" = "1" ]; then
  hd "5. record start/stop (RECORD=1)"
  start="$(curl -fsS --max-time 5 -X POST "$ORCH/api/v1/record/start" \
    -H 'content-type: application/json' -d '{"topics":"all"}' 2>/dev/null)"
  # The orchestrator assigns the run_id; accept any 'created'/'recording' state.
  state="$(printf '%s' "$start" | jq_py 'import sys,json;print(json.load(sys.stdin).get("state",""))' 2>/dev/null)"
  run_id="$(printf '%s' "$start" | jq_py 'import sys,json;print(json.load(sys.stdin).get("run_id",""))' 2>/dev/null)"
  if [ "$state" = "recording" ] || [ "$state" = "created" ]; then
    ok "POST /record/start -> ${run_id} (${state})"
    sleep 4
    curl -fsS --max-time 5 -X POST "$ORCH/api/v1/record/stop" -d '{}' >/dev/null 2>&1
    msgs="$(curl -fsS --max-time 5 "$ORCH/api/v1/record/status" 2>/dev/null \
      | jq_py 'import sys,json;print(json.load(sys.stdin).get("message_count") or 0)' 2>/dev/null || echo 0)"
    if [ "${msgs:-0}" -gt 0 ]; then ok "recorded ${msgs} messages"; else bad "recorded 0 messages"; fi
  else
    bad "POST /record/start did not enter recording: $start"
  fi
fi

hd "Summary: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
