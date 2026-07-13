# syntax=docker/dockerfile:1
# webrtc_streamer — ROS 2 node that subscribes to image topics and streams a
# low-latency WebRTC camera preview, so it is built FROM the ROS base image.
# rclpy is lazy-imported, so the FastAPI health endpoints serve without ROS.
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
COPY services/webrtc_streamer /app/services/webrtc_streamer
# Install the exact locked dependency set (--frozen: no `>=` re-resolution) plus
# the local packages non-editable (--no-editable). The lock's kairos-common path
# source (../../libs/kairos_common) resolves from the service dir.
RUN cd /app/services/webrtc_streamer \
    && uv sync --frozen --no-editable --no-dev

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
