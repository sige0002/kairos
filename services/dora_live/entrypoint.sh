#!/usr/bin/env bash
# dora_live entrypoint: source ROS + optional per-robot msgs overlay, then run
# the control sidecar (which supervises `dora run` internally).
#
# The overlay is prebuilt on the host by `make msgs-build` and mounted at
# $MSGS_OVERLAY (same contract as topic_monitor/recorder/probe); sourcing its
# setup.bash extends AMENT_PREFIX_PATH so the bridge resolves custom .msg
# types (cell B: AMENT is the ONLY type source for the bridge).
set -e

source "/opt/ros/${ROS_DISTRO:-jazzy}/setup.bash"

MSGS_OVERLAY="${MSGS_OVERLAY:-/opt/msgs_overlay}"
if [ -f "${MSGS_OVERLAY}/install/setup.bash" ]; then
    # shellcheck disable=SC1091
    source "${MSGS_OVERLAY}/install/setup.bash"
    echo "[dora_live] msgs overlay sourced: ${MSGS_OVERLAY}" >&2
fi
echo "[dora_live] AMENT_PREFIX_PATH=${AMENT_PREFIX_PATH}" >&2

# ---- Optional CPU-affinity cap (opt-in via DORA_LIVE_CPUS) -------------------
# dora_live spawns one process per bridged topic; each embeds a tokio runtime
# whose worker-thread count scales with the number of VISIBLE cpus (num_cpus
# reads sched_affinity), so on a many-core field host the bridge fleet is
# thousands of threads. Pinning this process to the first N cpus — every child
# (the supervisor, `dora run`, and each node) inherits the mask — bounds both
# the tokio worker threads and the worst-case CPU. A cgroup `cpus:` quota does
# NOT shrink num_cpus; sched_affinity (this) does. Unset = unrestricted. All
# failure paths warn to stderr and continue unrestricted (never die under -e).
if [ -n "${DORA_LIVE_CPUS:-}" ]; then
    if [[ ! "${DORA_LIVE_CPUS}" =~ ^[1-9][0-9]*$ ]]; then
        echo "[dora_live] DORA_LIVE_CPUS='${DORA_LIVE_CPUS}' is not a positive integer; running unrestricted." >&2
    elif ! command -v taskset >/dev/null 2>&1; then
        echo "[dora_live] DORA_LIVE_CPUS set but 'taskset' (util-linux) is unavailable; running unrestricted." >&2
    else
        # Pick the first N of the CURRENTLY ALLOWED cpus (not a literal 0..N-1
        # range): under a docker --cpuset-cpus like "4-19" the low cpus are not
        # ours to take, and pinning to them would fail (team review note).
        cpu_list="$(python3 - "${DORA_LIVE_CPUS}" <<'PYEOF' 2>/dev/null || true
import sys

n = int(sys.argv[1])
allowed: list[int] = []
with open("/proc/self/status") as f:
    for line in f:
        if line.startswith("Cpus_allowed_list:"):
            for part in line.split(":", 1)[1].strip().split(","):
                if "-" in part:
                    lo, hi = part.split("-")
                    allowed.extend(range(int(lo), int(hi) + 1))
                elif part:
                    allowed.append(int(part))
print(",".join(str(c) for c in allowed[:n]))
PYEOF
)"
        if [ -n "${cpu_list}" ] && taskset -pc "${cpu_list}" "$$" >/dev/null 2>&1; then
            echo "[dora_live] CPU affinity restricted to cpus ${cpu_list} (DORA_LIVE_CPUS=${DORA_LIVE_CPUS})." >&2
        else
            echo "[dora_live] taskset could not restrict affinity (wanted ${DORA_LIVE_CPUS} cpus); running unrestricted." >&2
        fi
    fi
fi

exec /opt/venv/bin/python -m dora_live.main
