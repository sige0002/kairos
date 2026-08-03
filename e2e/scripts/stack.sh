#!/usr/bin/env bash
# Lifecycle of the stack the Playwright acceptance suite drives.
#
# This is the ONLY place the E2E stack is started, stopped or perturbed — the
# Makefile target, Playwright's global setup, and the three tests that have to
# break something on purpose (§13-4 delete kairos.db, §13-5 rm -rf objects/<id>,
# recorder-honesty stop the recorder mid-take) all call these subcommands. One
# implementation means a developer who runs `stack.sh up` by hand gets
# byte-identical conditions to `make test-e2e`.
#
#   ./e2e/scripts/stack.sh up             # fresh data dir + stack + replay, waits ready
#   ./e2e/scripts/stack.sh down           # stop replay, remove the stack
#   ./e2e/scripts/stack.sh wait           # readiness only (no side effects)
#   ./e2e/scripts/stack.sh stop|start     # keep the containers, cycle them
#   ./e2e/scripts/stack.sh start-lenient  # boot without requiring a readable catalog
#   ./e2e/scripts/stack.sh stop-recorder  # recorder-honesty: kill ONLY the recorder
#   ./e2e/scripts/stack.sh start-recorder # ...and bring it back
#   ./e2e/scripts/stack.sh rm-db          # §13-4: delete the index
#   ./e2e/scripts/stack.sh rm-objects ID  # §13-5: out-of-band rm -rf
#   ./e2e/scripts/stack.sh ps|logs|env
#
# The stack runs on its own ports, its own ROS domain and its own data dir
# (e2e/stack.env), so it can sit beside a developer's `make up` stack.
#
# ---- one acceptance run at a time -------------------------------------------
# What it CANNOT sit beside is a second acceptance run. The stack is a
# singleton: one compose project, one data dir, one set of ports, one ROS
# domain. The problem is not that two runs would share — it is how the sharing
# fails. `up` begins by tearing the stack down and WIPING the data dir, so a
# second run does not queue behind the first, it destroys it mid-test. The
# victim sees a recording hang and then every later scenario fail against a
# stack that is no longer there, which reads exactly like a product defect.
# (Observed: a run lost its stack at 08:27:30 and spent 3.1 minutes timing out
# inside §13-1 before failing, with §13-2 and §13-3 collapsing behind it.)
#
# Two mechanisms, because one question is not the other:
#
#   flock — serialises the mutating subcommands against each other, so two
#     processes cannot interleave inside compose. That interleaving is real:
#     it surfaced once as `dependency failed to start: No such container: …`,
#     a container removed out from under the `up` that was starting it.
#
#   lease — a RUN holds the stack for its whole duration, and that outlives
#     every individual stack.sh invocation: `up` returns long before playwright
#     starts, and by the time the damage was done there was no stack.sh process
#     of the victim's left to hold anything. A flock alone would therefore have
#     prevented none of it. The lease records the process that owns the run
#     (this script's parent — `make`, or a developer's shell) and `down`
#     releases it. A dead owner's lease is ignored, so a crashed or ^C'd run
#     never wedges the next one.
#
# Only `up` refuses on a live foreign lease. It is the destructive one, and
# refusing it there is sufficient: the Makefile runs `up` as its own recipe
# line, so a refused run aborts before it can reach playwright or the trailing
# `down`. Serialising whole runs costs nothing that matters — the suite is
# `workers: 1` by design (see playwright.config.ts).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$HERE"

ENV_FILE="e2e/stack.env"
RUN_DIR="e2e/.run"
SERVICE_ENV="$RUN_DIR/service.env"
HOST_ENV="$RUN_DIR/host.env"
PROJECT="kairos-e2e"
REPLAY_PROJECT="kairos-e2e-replay"
TEST_COMPOSE="deploy/test/compose.yaml"
REPLAY_CID_FILE="$RUN_DIR/replay.cid"

# The services the acceptance suite drives. The webrtc streamer and the topic
# probe are deliberately absent: no scenario asserts on a camera preview, and
# two 1 GB ROS images that nothing reads would only slow the gate down.
SERVICES="recorder monitor orchestrator dora_runner frontend"

# Same derivation as the Makefile, so `make build` and this script tag and find
# the same images instead of one silently building :dev and the other looking
# for :0.1.0.
KAIROS_VERSION="$(cat VERSION 2>/dev/null || echo dev)"
export KAIROS_VERSION

# Export the whole profile. `docker compose --env-file` alone is not enough:
# compose lets the shell environment win over an env file, so a `ROBOT=<robot>`
# exported by the Makefile (or left in a developer's shell) would otherwise
# select the wrong recording config for the acceptance stack.
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

# compose runs the orchestrator/dora_runner as ${UID}:${GID} so the host-owned
# data mount stays writable. bash makes UID readonly, so it cannot simply be
# exported — it is written to a generated env file compose reads instead.
mkdir -p "$RUN_DIR"
printf 'UID=%s\nGID=%s\n' "$(id -u)" "$(id -g)" > "$HOST_ENV"

DATA_ABS="$HERE/${DATA_DIR#./}"
ORCH="http://127.0.0.1:${API_ORCH_PORT}"
REC="http://127.0.0.1:${RECORDER_PORT}"
DORA="http://127.0.0.1:${DORA_RUNNER_PORT}"
FE="http://127.0.0.1:${FRONTEND_PORT}"
MON="http://127.0.0.1:${TOPIC_MONITOR_PORT}"

compose() {
  # compose.archive.yaml mounts the acceptance archive root (§6.1 scenario 6)
  # into the orchestrator; it exists only for this stack, never in a deploy.
  docker compose --env-file "$ENV_FILE" --env-file "$HOST_ENV" \
    -f compose.yaml -f e2e/compose.archive.yaml -p "$PROJECT" "$@"
}
say() { printf '\033[36me2e:\033[0m %s\n' "$*"; }
die() { printf '\033[31me2e: %s\033[0m\n' "$*" >&2; exit 1; }

# ---- one run at a time (see the header) -------------------------------------
LOCK_FILE="$RUN_DIR/stack.lock"
OWNER_FILE="$RUN_DIR/stack.owner"
# The process that owns the whole RUN, not this invocation: `make test-e2e` for
# the gate, the developer's shell for a hand-driven stack. Either outlives the
# `up` that claims the lease, which is the entire point.
OWNER_PID="${PPID:-$$}"

# Field 22 of /proc/<pid>/stat is the process's start time in clock ticks.
# Recording it turns "is that pid alive?" into "is it still the SAME process?",
# so a recycled pid cannot make a dead run's lease look live.
proc_start_ticks() {
  [ -r "/proc/$1/stat" ] || return 0
  awk '{print $22}' "/proc/$1/stat" 2>/dev/null || true
}

proc_cmdline() {
  if [ -r "/proc/$1/cmdline" ]; then
    tr '\0' ' ' < "/proc/$1/cmdline" | cut -c1-60
  else
    printf 'unknown'
  fi
}

# Absent lease file = no owner, which is the NORMAL first run, not an error.
# `sed` on a missing file exits non-zero, and under `set -e` that would abort
# `up` before it ever started — so this always succeeds and answers with the
# empty string.
lease_field() {
  [ -f "$OWNER_FILE" ] || return 0
  sed -n "s/^$1=//p" "$OWNER_FILE" 2>/dev/null || true
}

lease_is_live() {
  local pid="$1" ticks="$2" now
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  now="$(proc_start_ticks "$pid")"
  # Unknown either side (no /proc): fall back to liveness alone rather than
  # calling a live run dead, which would let it be destroyed.
  [ -z "$ticks" ] || [ -z "$now" ] || [ "$ticks" = "$now" ]
}

claim_lease() {
  local pid ticks
  pid="$(lease_field pid)"
  ticks="$(lease_field ticks)"
  if [ -n "$pid" ] && [ "$pid" != "$OWNER_PID" ] && lease_is_live "$pid" "$ticks"; then
    printf '\033[31me2e: another acceptance run holds the stack — pid %s (%s), started %s\033[0m\n' \
      "$pid" "$(lease_field cmd)" "$(lease_field started)" >&2
    printf 'Starting now would tear down ITS containers and wipe the data dir under a\n' >&2
    printf 'live test. Wait for it to finish. If that run is gone, release the stack:\n' >&2
    printf '  bash %s down\n' "$HERE/e2e/scripts/stack.sh" >&2
    exit 1
  fi
  {
    echo "pid=$OWNER_PID"
    echo "ticks=$(proc_start_ticks "$OWNER_PID")"
    echo "started=$(date '+%Y-%m-%d %H:%M:%S')"
    echo "cmd=$(proc_cmdline "$OWNER_PID")"
  } > "$OWNER_FILE"
}

# Whether the lease's recorded owner sits anywhere on THIS process's ancestor
# chain. The run owner can be a grandparent, not the PPID: make executes the
# gate's compound recipe line through an intermediate `sh -c`, so the run's own
# `down` sees the owning make two levels up — and a plain pid comparison called
# every green run's teardown a foreign release. A warning that fires on the
# normal path trains people to ignore the one that matters. A live ancestor is
# definitionally the same process the lease named if the pid matches, so no
# start-ticks check is needed here; a recycled-pid coincidence means the
# original owner is dead, and releasing a dead owner's lease is silent by
# design anyway.
lease_owned_by_ancestor() {
  local pid="$1" cur="$$" ppid
  [ -n "$pid" ] || return 1
  while [ -n "$cur" ] && [ "$cur" -gt 1 ] 2>/dev/null; do
    [ "$cur" = "$pid" ] && return 0
    ppid="$(awk '{print $4}' "/proc/$cur/stat" 2>/dev/null)" || return 1
    [ -n "$ppid" ] && [ "$ppid" != "$cur" ] || return 1
    cur="$ppid"
  done
  return 1
}

release_lease() {
  [ -f "$OWNER_FILE" ] || return 0
  local pid ticks
  pid="$(lease_field pid)"
  ticks="$(lease_field ticks)"
  # Taking down a stack someone else is using is a legitimate thing to ask for
  # (that is how a wedged lease gets cleared), but it must never be silent.
  if [ -n "$pid" ] && [ "$pid" != "$OWNER_PID" ] && ! lease_owned_by_ancestor "$pid" \
      && lease_is_live "$pid" "$ticks"; then
    say "WARNING: releasing a lease still held by pid $pid ($(lease_field cmd)) — that run's stack is now gone"
  fi
  rm -f "$OWNER_FILE"
}

# Run a mutating subcommand under the file lock. Every mutator goes through
# here: flock is advisory, so one that does not is a hole in the serialisation
# rather than a minor omission. Read-only subcommands (wait/env/ps/logs) are
# deliberately outside it — blocking a status query behind a 2-minute `start`
# would make the lock the thing people work around.
with_lock() {
  mkdir -p "$RUN_DIR"
  if ! command -v flock >/dev/null 2>&1; then
    say "WARNING: flock not found — running WITHOUT the single-run lock; a second acceptance run can destroy this one"
    "$@"
    return
  fi
  exec {lock_fd}>>"$LOCK_FILE"
  if ! flock -w "${STACK_LOCK_WAIT:-120}" "$lock_fd"; then
    die "timed out after ${STACK_LOCK_WAIT:-120}s waiting for the stack lock ($LOCK_FILE) — another stack.sh is mid-operation"
  fi
  "$@"
}

# ---- image guard ------------------------------------------------------------
# Follows the repo rule that `up` never builds (deploy/test and the Makefile do
# the same): building needs a network even when nothing changed. The failure
# has to name the fix, not just the missing tag.
require_images() {
  local missing=()
  for img in \
    "kairos-rosbag2-recorder:${ROS_DISTRO}" \
    "kairos-topic-monitor:${ROS_DISTRO}" \
    "kairos-api-orchestrator:${KAIROS_VERSION}" \
    "kairos-dora-runner:${KAIROS_VERSION}" \
    "kairos-frontend:${KAIROS_VERSION}"
  do
    docker image inspect "$img" >/dev/null 2>&1 || missing+=("$img")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    printf '\033[31me2e: missing images: %s\033[0m\n' "${missing[*]}" >&2
    printf 'Build them first (this needs a network):\n  make build\n' >&2
    printf 'A stale image is worse than a missing one — rebuild after changing services/.\n' >&2
    exit 1
  fi
  docker image inspect "kairos-rosbag-player:${ROS_DISTRO}" >/dev/null 2>&1 || {
    say "building the replay harness image (kairos-rosbag-player:${ROS_DISTRO})"
    docker compose --env-file "$ENV_FILE" -f "$TEST_COMPOSE" build rosbag_player
  }
}

# ---- generated container env ------------------------------------------------
# DATA_DIR is the one key whose host and container meaning differ: the compose
# volume needs the host path, the services need /data. Generating the container
# copy (instead of maintaining a second file) removes the only way the two env
# files could drift apart.
write_service_env() {
  mkdir -p "$RUN_DIR"
  {
    echo "# GENERATED by e2e/scripts/stack.sh from $ENV_FILE — do not edit."
    grep -vE '^\s*(DATA_DIR|KAIROS_ENV_FILE)\s*=' "$ENV_FILE"
    echo "DATA_DIR=/data"
  } > "$SERVICE_ENV"
}

# ---- readiness --------------------------------------------------------------
http_ok() { curl -fsS --max-time 3 -o /dev/null "$1" 2>/dev/null; }

wait_for() {
  local name="$1" url="$2" deadline=$(( SECONDS + ${3:-90} ))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if http_ok "$url"; then say "ready: $name"; return 0; fi
    sleep 1
  done
  printf '\033[31me2e: %s never became ready at %s\033[0m\n' "$name" "$url" >&2
  compose logs --tail=40 "${4:-}" 2>/dev/null || true
  return 1
}

cmd_wait() {
  wait_for orchestrator "$ORCH/healthz" 90 orchestrator || die "orchestrator not ready"
  # /healthz is liveness by design (see compose.yaml) — it answers before the
  # store is usable. The catalog answering is what the tests actually need, and
  # waiting on it here turns a startup race into a readiness wait instead of a
  # 500 in the middle of the first scenario.
  #
  # WAIT_CATALOG=0 is for the one scenario that is TESTING whether the catalog
  # survives a rebuild: there, an unreadable catalog is the finding, and it has
  # to be reported by the assertion that explains it rather than by a readiness
  # timeout here.
  if [ "${WAIT_CATALOG:-1}" = "1" ]; then
    wait_for catalog "$ORCH/api/v1/captures?limit=1" 90 orchestrator || die "catalog not readable"
  fi
  wait_for recorder     "$REC/healthz"  90 recorder     || die "recorder not ready"
  wait_for dora_runner  "$DORA/healthz" 120 dora_runner || die "dora_runner not ready"
  wait_for frontend     "$FE/"          60 frontend     || die "frontend not ready"
  # The monitor is not on any scenario's critical path (Collect reads its topic
  # list from GET /config, not from the monitor), so a slow DDS discovery must
  # not fail the gate — but staying silent about it would hide a real outage.
  if wait_for monitor "$MON/readyz" 45 monitor; then :; else
    say "WARNING: topic_monitor is not ready — live Hz panels will be empty"
  fi
}

# ---- subcommands ------------------------------------------------------------
cmd_reset() {
  say "resetting $DATA_ABS"
  # The recorder runs as root and its objects/<id>/ trees are root-owned, so the
  # host user cannot always remove them. Do it from a container that can.
  if [ -d "$DATA_ABS" ]; then
    docker run --rm --user 0:0 -v "$DATA_ABS:/data" \
      --entrypoint sh "kairos-api-orchestrator:${KAIROS_VERSION}" \
      -c 'rm -rf /data/..?* /data/.[!.]* /data/*' >/dev/null 2>&1 || true
  fi
  rm -rf "$DATA_ABS"
  mkdir -p "$DATA_ABS"
  # The archive destination (§6.1 scenario 6) starts empty too: the run
  # correctly refuses a non-empty destination, so a leftover export would fail
  # the scenario for the wrong reason. Orchestrator-written = host-uid-owned,
  # so no container is needed to remove it.
  rm -rf "$HERE/e2e/.run/archive"
  mkdir -p "$HERE/e2e/.run/archive"
  write_service_env
}

cmd_up() {
  # Before anything is torn down or wiped: is this stack someone else's?
  claim_lease
  require_images
  # Remove any previous containers BEFORE wiping the data dir. `up -d` reuses a
  # running container, and a service that keeps running while its data
  # directory is deleted underneath it holds an open handle to a file that no
  # longer exists — the orchestrator then answers /healthz (liveness) perfectly
  # while every catalog read 500s. Costing a few seconds of recreation is the
  # price of each run starting from an actually-fresh process.
  cmd_down
  cmd_reset
  say "starting stack ($PROJECT) on ports ${API_ORCH_PORT}/${FRONTEND_PORT}, ROS_DOMAIN_ID=$ROS_DOMAIN_ID"
  compose up -d $SERVICES
  cmd_wait
  cmd_replay_start
  say "up — UI at $FE/  API at $ORCH/api/v1"
}

cmd_down() {
  cmd_replay_stop
  say "removing stack ($PROJECT)"
  compose down --remove-orphans >/dev/null 2>&1 || true
}

# The `down` SUBCOMMAND ends the run and hands the stack back. cmd_up's internal
# teardown deliberately does not: it is re-creating the stack it just claimed,
# and releasing there would drop its own lease a moment after taking it.
cmd_down_release() {
  cmd_down
  release_lease
}

# `stop`/`start` keep the containers (and therefore the exact same env) so the
# §13-4 rebuild scenario restarts the SAME stack rather than a new one that
# might differ in some way the test would then be crediting to the rebuild.
cmd_stop()  { say "stopping containers"; compose stop >/dev/null; }
cmd_start() { say "starting containers"; compose start >/dev/null; cmd_wait; }
# Boot without insisting the catalog answers — see WAIT_CATALOG in cmd_wait.
cmd_start_lenient() {
  say "starting containers (catalog readiness not required)"
  compose start >/dev/null
  WAIT_CATALOG=0 cmd_wait
}

# The recorder alone, so the rest of the stack stays up and the browser keeps
# talking to a healthy orchestrator — which is the whole point of the scenario:
# the UI has to say it cannot see the recorder, not go blank.
#
# `stop`, not `kill`: an operator restarting the recorder service is the case
# under test, and it is ALSO the harsher one for the UI. The recorder installs
# no shutdown hook that finalises a take (main.py wires no lifespan), so the
# capture is left exactly as a crash leaves it — `state=recording` in the
# manifest, a partial bag on disk — and the recovery has to come from the
# recorder's own startup reconciliation rather than from a tidy goodbye.
cmd_stop_recorder() {
  say "stopping the recorder container (the rest of the stack keeps running)"
  compose stop recorder >/dev/null
}
cmd_start_recorder() {
  say "starting the recorder container"
  compose start recorder >/dev/null
  # Only the recorder's own readiness: cmd_wait would also re-probe dora_runner
  # and the monitor, which were never stopped, and would turn an unrelated slow
  # service into this scenario's failure.
  wait_for recorder "$REC/healthz" 90 recorder || die "recorder not ready"
}

cmd_replay_start() {
  cmd_replay_stop
  local bag="${BAG:-airoa-moma-mcap/235210}"
  say "replaying $bag on ROS_DOMAIN_ID=$ROS_DOMAIN_ID (loop)"
  mkdir -p "$RUN_DIR"
  BAG="$bag" LOOP=--loop \
    docker compose --env-file "$ENV_FILE" -f "$TEST_COMPOSE" -p "$REPLAY_PROJECT" \
      run --rm -d rosbag_player > "$REPLAY_CID_FILE"
  say "replay container $(cut -c1-12 < "$REPLAY_CID_FILE")"
}

cmd_replay_stop() {
  if [ -f "$REPLAY_CID_FILE" ]; then
    docker rm -f "$(cat "$REPLAY_CID_FILE")" >/dev/null 2>&1 || true
    rm -f "$REPLAY_CID_FILE"
  fi
  docker compose --env-file "$ENV_FILE" -f "$TEST_COMPOSE" -p "$REPLAY_PROJECT" \
    down --remove-orphans >/dev/null 2>&1 || true
}

# §13-4: delete the index and nothing else. The sidecars stay, which is the
# whole point — the catalog has to come back from them.
cmd_rm_db() {
  say "deleting $DATA_ABS/kairos.db"
  rm -f "$DATA_ABS/kairos.db" "$DATA_ABS/kairos.db-wal" "$DATA_ABS/kairos.db-shm"
  [ ! -e "$DATA_ABS/kairos.db" ] || die "kairos.db still present"
}

# §13-5: the out-of-band removal kairos must never mistake for a deletion.
# Root-owned tree (the recorder wrote it), so this goes through a container.
cmd_rm_objects() {
  local id="${1:?capture_id required}"
  [ -d "$DATA_ABS/objects/$id" ] || die "objects/$id does not exist — nothing to remove"
  say "rm -rf objects/$id (out of band)"
  docker run --rm --user 0:0 -v "$DATA_ABS:/data" \
    --entrypoint sh "kairos-api-orchestrator:${KAIROS_VERSION}" \
    -c "rm -rf '/data/objects/$id'"
  [ ! -e "$DATA_ABS/objects/$id" ] || die "objects/$id survived the removal"
}

cmd_env() {
  # Consumed by the Playwright fixtures, so they never re-parse stack.env.
  cat <<EOF
E2E_BASE_URL=$FE
E2E_API_URL=$ORCH/api/v1
E2E_ORCH_URL=$ORCH
E2E_DATA_DIR=$DATA_ABS
E2E_PROJECT=$PROJECT
E2E_STACK_SH=$HERE/e2e/scripts/stack.sh
EOF
}

# Everything that PERTURBS the stack goes through with_lock; everything that
# only reads it does not.
case "${1:-}" in
  up)           with_lock cmd_up ;;
  down)         with_lock cmd_down_release ;;
  reset)        with_lock cmd_reset ;;
  wait)         cmd_wait ;;
  stop)          with_lock cmd_stop ;;
  start)         with_lock cmd_start ;;
  start-lenient) with_lock cmd_start_lenient ;;
  stop-recorder)  with_lock cmd_stop_recorder ;;
  start-recorder) with_lock cmd_start_recorder ;;
  replay-start) with_lock cmd_replay_start ;;
  replay-stop)  with_lock cmd_replay_stop ;;
  rm-db)        with_lock cmd_rm_db ;;
  rm-objects)   shift; with_lock cmd_rm_objects "$@" ;;
  env)          cmd_env ;;
  ps)           compose ps ;;
  logs)         shift; compose logs --tail="${TAIL:-100}" "$@" ;;
  *)
    grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'
    exit 1 ;;
esac
