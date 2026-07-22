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
        cpu_n="${DORA_LIVE_CPUS}"
        cpu_online="$(nproc 2>/dev/null || echo 0)"
        if [ "${cpu_online}" -gt 0 ] && [ "${cpu_n}" -gt "${cpu_online}" ]; then
            echo "[dora_live] DORA_LIVE_CPUS=${cpu_n} exceeds ${cpu_online} online cpus; clamping to ${cpu_online}." >&2
            cpu_n="${cpu_online}"
        fi
        if taskset -pc "0-$((cpu_n - 1))" "$$" >/dev/null 2>&1; then
            echo "[dora_live] CPU affinity restricted to cpus 0-$((cpu_n - 1)) (DORA_LIVE_CPUS=${DORA_LIVE_CPUS})." >&2
        else
            echo "[dora_live] taskset could not set affinity to cpus 0-$((cpu_n - 1)); running unrestricted." >&2
        fi
    fi
fi

exec /opt/venv/bin/python -m dora_live.main
