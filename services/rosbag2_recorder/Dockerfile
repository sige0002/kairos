# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89
# Digest-pinned on purpose: an unpinned tag makes BuildKit resolve it against the
# registry on EVERY build, which fails where there is no network (robot in the field).
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
# Uses uv rather than apt's python3-pip/python3-venv: the ros:*-ros-base images
# only enable the Ubuntu "main" component, so that apt install 404s on mirrors
# without "universe" (seen on a real-robot network). UV_PYTHON_PREFERENCE=
# only-system + a bare "python3" interpreter name keep uv from trying to
# download a standalone Python build (also DNS-blocked on the same networks).
# uv is pinned by version + digest for reproducible builds (see README Releases).
FROM ros:${ROS_DISTRO}-ros-base AS builder
COPY --from=ghcr.io/astral-sh/uv:0.10.0@sha256:78a7ff97cd27b7124a5f3c2aefe146170793c56a1e03321dd31a289f6d82a04f /uv /usr/local/bin/uv

# Build the venv with --system-site-packages so the ROS-provided rclpy (added
# later) remains importable alongside the pip-installed app deps. The venv lives
# at UV_PROJECT_ENVIRONMENT so `uv sync` installs into it (not a project-local
# .venv).
# UV_HTTP_TIMEOUT: uv's default is a 30 s READ timeout — a >30 s no-byte stall
# (congested field Wi-Fi / cellular) kills the download, and the build with it.
# 600 s rides out stalls; a healthy link never notices (read, not total, time).
ENV VENV=/opt/venv \
    UV_PYTHON_PREFERENCE=only-system \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_HTTP_TIMEOUT=600 \
    UV_HTTP_RETRIES=5
RUN uv venv --python python3 --system-site-packages $VENV
ENV PATH="$VENV/bin:$PATH"

WORKDIR /app
COPY libs/kairos_common /app/libs/kairos_common
COPY services/rosbag2_recorder /app/services/rosbag2_recorder
# Install the exact locked dependency set (--frozen: no `>=` re-resolution) plus
# the local packages non-editable (--no-editable, so the copied venv has no .pth
# pointing back at this builder stage's /app). The lock's kairos-common path
# source (../../libs/kairos_common) resolves from the service dir. --no-dev omits
# the dev group (none defined) and the test extra stays out (not a default group).
RUN cd /app/services/rosbag2_recorder \
    && uv sync --frozen --no-editable --no-dev

# ---- runtime ----------------------------------------------------------------
FROM ros:${ROS_DISTRO}-ros-base AS runtime
ARG ROS_DISTRO
ENV VENV=/opt/venv
ENV PATH="$VENV/bin:$PATH"
COPY --from=builder /opt/venv /opt/venv

# MCAP is the canonical recording format; install the rosbag2 MCAP storage
# plugin so `ros2 bag record --storage mcap` works. Also bundle the Cyclone DDS
# RMW so the image can talk to either Fast DDS (default) or Cyclone DDS robots
# by switching RMW_IMPLEMENTATION at deploy time (ROS 2 requires the same RMW on
# both ends; cross-vendor interop is not supported). See docs/specs/*/config.md.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ros-${ROS_DISTRO}-rosbag2-storage-mcap \
        ros-${ROS_DISTRO}-rmw-cyclonedds-cpp \
    && rm -rf /var/lib/apt/lists/*

# Internal service port (reached at localhost:8010 under host networking). The
# value is sourced from settings.py (RECORDER_PORT, default 8010) at runtime;
# EXPOSE is metadata only. Do not set ENV RECORDER_PORT here — that would be a
# second default that can drift from settings.py / compose's ${RECORDER_PORT}.
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
