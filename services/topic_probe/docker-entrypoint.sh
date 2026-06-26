#!/bin/bash
# Container entrypoint for topic_probe.
#
# Sources the ROS 2 underlay and, when present, a custom-message colcon overlay
# so rclpy can resolve the rosidl type-support needed to DECODE custom message
# types. topic_probe creates subscriptions BY TYPE (get_message(type_str)) and
# decodes the payload; without the type-support a custom-type topic fails to
# subscribe and exposes no fields. Mirrors topic_monitor / rosbag2_recorder so
# the probe sees the same custom-type topics they do.
#
# The overlay is mounted (read-only) at $MSGS_OVERLAY and is OPTIONAL: if it is
# unset or has no install/setup.bash, only standard types can be probed — the
# default deployment, and NOT an error.
set -e

# ROS 2 underlay (same as the stock ros_entrypoint.sh).
source "${ROS_ROOT:-/opt/ros}/${ROS_DISTRO}/setup.bash"

# Optional custom-message overlay.
if [ -n "${MSGS_OVERLAY}" ] && [ -f "${MSGS_OVERLAY}/install/setup.bash" ]; then
    # shellcheck disable=SC1091
    source "${MSGS_OVERLAY}/install/setup.bash"
    echo "topic_probe: sourced custom-message overlay at ${MSGS_OVERLAY}" >&2
elif [ -n "${MSGS_OVERLAY}" ]; then
    echo "topic_probe: MSGS_OVERLAY=${MSGS_OVERLAY} set but" \
         "${MSGS_OVERLAY}/install/setup.bash not found; custom types unavailable" >&2
fi

exec "$@"
