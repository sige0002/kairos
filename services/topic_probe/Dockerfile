# syntax=docker/dockerfile:1
# topic_probe — ROS 2 node that DECODES one selected topic at a time to plot its
# numeric fields. Built FROM the ROS base image because the live decode path uses
# rclpy + rosidl_runtime_py (resolving message classes by type). Isolated from
# the monitor/recorder so a probe crash can never affect recording/monitoring.
ARG ROS_DISTRO=jazzy

# ---- builder ----------------------------------------------------------------
FROM ros:${ROS_DISTRO}-ros-base AS builder
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

ENV VENV=/opt/venv
RUN python3 -m venv --system-site-packages $VENV
ENV PATH="$VENV/bin:$PATH"

WORKDIR /app
COPY libs/kairos_common /app/libs/kairos_common
COPY services/topic_probe /app/services/topic_probe
RUN pip install --no-cache-dir ./libs/kairos_common ./services/topic_probe

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
