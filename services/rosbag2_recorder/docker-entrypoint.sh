#!/bin/bash
# Container entrypoint for rosbag2_recorder.
#
# Sources the ROS 2 underlay and, when present, a custom-message colcon overlay
# so that `ros2 bag record` (spawned later by the app as a subprocess) can
# resolve the rosidl type-support for custom message types (e.g.
# tmc_control_msgs/msg/ServoState). Without resolvable type-support rosbag2
# silently SKIPS such topics. See docs/specs/ja/rosbag2_recorder.md
# ("カスタムメッセージ対応").
#
# The overlay is mounted (read-only) at $MSGS_OVERLAY and must contain a
# colcon install space, i.e. $MSGS_OVERLAY/install/setup.bash. It is optional:
# if MSGS_OVERLAY is unset or the install space is absent, only standard types
# are recordable, which is the default deployment.
#
# Because the env this script establishes is inherited by the app process and
# every subprocess it spawns, the overlay only needs to be sourced once here.
set -e

# ROS 2 underlay (same as the stock ros_entrypoint.sh). ROS_ROOT defaults to the
# standard install root and is overridable (e.g. for tests).
source "${ROS_ROOT:-/opt/ros}/${ROS_DISTRO}/setup.bash"

# Optional custom-message overlay.
if [ -n "${MSGS_OVERLAY}" ] && [ -f "${MSGS_OVERLAY}/install/setup.bash" ]; then
    # shellcheck disable=SC1091
    source "${MSGS_OVERLAY}/install/setup.bash"
    echo "rosbag2_recorder: sourced custom-message overlay at ${MSGS_OVERLAY}" >&2
elif [ -n "${MSGS_OVERLAY}" ]; then
    echo "rosbag2_recorder: MSGS_OVERLAY=${MSGS_OVERLAY} set but" \
         "${MSGS_OVERLAY}/install/setup.bash not found; custom types unavailable" >&2
fi

exec "$@"
