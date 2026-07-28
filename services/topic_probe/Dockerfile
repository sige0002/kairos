# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89
# Digest-pinned on purpose: an unpinned tag makes BuildKit resolve it against the
# registry on EVERY build, which fails where there is no network (robot in the field).
# topic_probe — ROS 2 node that DECODES one selected topic at a time to plot its
# numeric fields. Built FROM the ROS base image because the live decode path uses
# rclpy + rosidl_runtime_py (resolving message classes by type). Isolated from
# the monitor/recorder so a probe crash can never affect recording/monitoring.
ARG ROS_DISTRO=jazzy

# ---- builder ----------------------------------------------------------------
# Uses uv rather than apt's python3-pip/python3-venv: the ros:*-ros-base images
# only enable the Ubuntu "main" component, so that apt install 404s on mirrors
# without "universe" (seen on a real-robot network). UV_PYTHON_PREFERENCE=
# only-system + a bare "python3" interpreter name keep uv from trying to
# download a standalone Python build (also DNS-blocked on the same networks).
# uv is pinned by version + digest for reproducible builds (see README Releases).
FROM ros:${ROS_DISTRO}-ros-base AS builder
COPY --from=ghcr.io/astral-sh/uv:0.10.0@sha256:78a7ff97cd27b7124a5f3c2aefe146170793c56a1e03321dd31a289f6d82a04f /uv /usr/local/bin/uv

# --system-site-packages so the ROS-provided rclpy stays importable; the venv
# lives at UV_PROJECT_ENVIRONMENT so `uv sync` installs into it.
ENV VENV=/opt/venv \
    UV_PYTHON_PREFERENCE=only-system \
    UV_PROJECT_ENVIRONMENT=/opt/venv
RUN uv venv --python python3 --system-site-packages $VENV
ENV PATH="$VENV/bin:$PATH"

WORKDIR /app
COPY libs/kairos_common /app/libs/kairos_common
COPY services/topic_probe /app/services/topic_probe
# Install the exact locked dependency set (--frozen: no `>=` re-resolution) plus
# the local packages non-editable (--no-editable). The lock's kairos-common path
# source (../../libs/kairos_common) resolves from the service dir.
RUN cd /app/services/topic_probe \
    && uv sync --frozen --no-editable --no-dev

# ---- runtime ----------------------------------------------------------------
FROM ros:${ROS_DISTRO}-ros-base AS runtime
ARG ROS_DISTRO
ENV VENV=/opt/venv
ENV PATH="$VENV/bin:$PATH"
COPY --from=builder /opt/venv /opt/venv

# Bundle the Cyclone DDS RMW so the image can talk to either Fast DDS (default)
# or Cyclone DDS robots by switching RMW_IMPLEMENTATION at deploy time (ROS 2
# requires the same RMW on both ends). See docs/specs/*/config.md.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ros-${ROS_DISTRO}-rmw-cyclonedds-cpp \
    && rm -rf /var/lib/apt/lists/*

# Public port from the shared .env (TOPIC_PROBE_PORT).
EXPOSE 8003

# Optional custom-message overlay (parity with recorder/monitor): mounted at
# $MSGS_OVERLAY, the entrypoint sources its install/setup.bash if present so
# rclpy can resolve + DECODE custom message types on a live robot. Empty/absent
# overlay = standard types only (not an error).
ENV MSGS_OVERLAY=/opt/msgs_overlay
COPY services/topic_probe/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["python", "-m", "topic_probe.main"]
