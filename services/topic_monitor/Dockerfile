# syntax=docker/dockerfile:1
# topic_monitor — ROS 2 node that subscribes non-intrusively (raw/no-decode) for
# lightweight liveness metrics, so it is built FROM the ROS base image. rclpy is
# lazy-imported, so the FastAPI health endpoints serve even before ROS spins up.
ARG ROS_DISTRO=jazzy

# ---- builder ----------------------------------------------------------------
# Uses uv rather than apt's python3-pip/python3-venv: the ros:*-ros-base images
# only enable the Ubuntu "main" component, so that apt install 404s on mirrors
# without "universe" (seen on a real-robot network). UV_PYTHON_PREFERENCE=
# only-system + a bare "python3" interpreter name keep uv from trying to
# download a standalone Python build (also DNS-blocked on the same networks).
FROM ros:${ROS_DISTRO}-ros-base AS builder
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

ENV VENV=/opt/venv UV_PYTHON_PREFERENCE=only-system
RUN uv venv --python python3 --system-site-packages $VENV
ENV PATH="$VENV/bin:$PATH"

WORKDIR /app
COPY libs/kairos_common /app/libs/kairos_common
COPY services/topic_monitor /app/services/topic_monitor
# --no-editable: a plain uv pip install of a local path defaults to editable,
# whose .pth points at this builder stage's /app — absent in the runtime stage.
RUN uv pip install --no-cache-dir --no-editable ./libs/kairos_common ./services/topic_monitor

# ---- runtime ----------------------------------------------------------------
FROM ros:${ROS_DISTRO}-ros-base AS runtime
ARG ROS_DISTRO
ENV VENV=/opt/venv
ENV PATH="$VENV/bin:$PATH"
COPY --from=builder /opt/venv /opt/venv

# Bundle the Cyclone DDS RMW so the image can talk to either Fast DDS (default)
# or Cyclone DDS robots by switching RMW_IMPLEMENTATION at deploy time (ROS 2
# requires the same RMW on both ends; cross-vendor interop is not supported).
# See docs/specs/*/config.md.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ros-${ROS_DISTRO}-rmw-cyclonedds-cpp \
    && rm -rf /var/lib/apt/lists/*

# Public port from the shared .env (TOPIC_MONITOR_PORT).
EXPOSE 8001

# Optional custom-message overlay (parity with rosbag2_recorder): mounted at
# $MSGS_OVERLAY, the entrypoint sources its install/setup.bash if present so
# rclpy can subscribe to custom message types on a live robot. Empty/absent
# overlay = standard types only (not an error).
ENV MSGS_OVERLAY=/opt/msgs_overlay
COPY services/topic_monitor/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["python", "-m", "topic_monitor.main"]
