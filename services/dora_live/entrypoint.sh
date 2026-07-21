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

exec /opt/venv/bin/python -m dora_live.main
