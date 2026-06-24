# syntax=docker/dockerfile:1
# rosbag2_recorder — ROS 2 node using rosbag2 MCAP storage, built FROM the ROS
# base image so `ros2 bag record` and (later) rclpy are available.
#
# Custom message support: the entrypoint optionally sources a pre-built colcon
# overlay of custom msg packages, mounted read-only at $MSGS_OVERLAY (default
# /opt/msgs_overlay), so the spawned `ros2 bag record` can resolve type-support
# for custom types (see docs/specs/ja/rosbag2_recorder.md). The overlay is
# provided at deploy time (compose volume); none is bundled in the image.
ARG ROS_DISTRO=jazzy

# ---- builder: install Python deps into a venv on top of system Python -------
FROM ros:${ROS_DISTRO}-ros-base AS builder
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Build the venv with --system-site-packages so the ROS-provided rclpy (added
# later) remains importable alongside the pip-installed app deps.
ENV VENV=/opt/venv
RUN python3 -m venv --system-site-packages $VENV
ENV PATH="$VENV/bin:$PATH"

WORKDIR /app
COPY libs/kairos_common /app/libs/kairos_common
COPY services/rosbag2_recorder /app/services/rosbag2_recorder
RUN pip install --no-cache-dir ./libs/kairos_common ./services/rosbag2_recorder

# ---- runtime ----------------------------------------------------------------
FROM ros:${ROS_DISTRO}-ros-base AS runtime
ARG ROS_DISTRO
ENV VENV=/opt/venv
ENV PATH="$VENV/bin:$PATH"
COPY --from=builder /opt/venv /opt/venv

# MCAP is the canonical recording format; install the rosbag2 MCAP storage
# plugin so `ros2 bag record --storage mcap` works.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ros-${ROS_DISTRO}-rosbag2-storage-mcap \
    && rm -rf /var/lib/apt/lists/*

# Internal service port (reached at localhost:8010 under host networking).
ENV RECORDER_PORT=8010
EXPOSE 8010

# Default mount path for the optional custom-message colcon overlay. The
# entrypoint sources $MSGS_OVERLAY/install/setup.bash if it exists; if nothing
# is mounted there, only standard message types are recordable.
ENV MSGS_OVERLAY=/opt/msgs_overlay

# Custom entrypoint sources the ROS underlay + (optional) custom-message overlay
# into the process env, so the app and every `ros2 bag record` subprocess it
# spawns inherit the type-support. Replaces the stock ros_entrypoint.sh.
COPY services/rosbag2_recorder/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["python", "-m", "rosbag2_recorder.main"]
