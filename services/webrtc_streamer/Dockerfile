# syntax=docker/dockerfile:1
# webrtc_streamer — ROS 2 node that subscribes to image topics and streams a
# low-latency WebRTC camera preview, so it is built FROM the ROS base image.
# rclpy is lazy-imported, so the FastAPI health endpoints serve without ROS.
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
COPY services/webrtc_streamer /app/services/webrtc_streamer
RUN pip install --no-cache-dir ./libs/kairos_common ./services/webrtc_streamer

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

# Public port from the shared .env (WEBRTC_PORT) for signaling / http.
EXPOSE 8002

CMD ["python", "-m", "webrtc_streamer.main"]
