# syntax=docker/dockerfile:1
# dora_live — live DDS ingest via dora-ros2-bridge + shared-memory fan-out.
#
# dora is built from source at a PINNED upstream-main commit: released dora
# (0.5.0 / 1.0.0-rc.x) hardcodes DDS domain 0, while upstream main resolves
# Ros2Context(domain_id) arg > ROS_DOMAIN_ID env > 0 — required for the real
# robot (domain 1) and multi-domain dev. CLI and wheel come from the same
# commit (mixing them breaks the internal protocol). Exit condition: switch to
# the PyPI wheel once an official release ships domain support (dora-rs/dora#1626).
#
# The builder stage is textually identical to the benchmark image
# (~/ros2_to_dora/docker/Dockerfile.main) so the Docker layer cache is shared.
ARG ROS_DISTRO=jazzy

# ---------------------------------------------------------------------------
# Stage 1: build the dora CLI binary + the dora-rs python wheel (maturin).
# ---------------------------------------------------------------------------
FROM ros:jazzy-ros-base AS builder
ENV DEBIAN_FRONTEND=noninteractive
ARG DORA_COMMIT

RUN apt-get update && apt-get install -y --no-install-recommends \
        git build-essential pkg-config libssl-dev clang cmake \
        curl ca-certificates python3-dev python3-pip patchelf \
    && rm -rf /var/lib/apt/lists/*

# Rust (edition 2024 / MSRV 1.88.0 -> use a recent stable that satisfies it).
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
        | sh -s -- -y --default-toolchain 1.88.0 --profile minimal
ENV PATH="/root/.cargo/bin:${PATH}"

RUN pip install --no-cache-dir --break-system-packages "maturin>=1.5"

# Pin the source to the requested commit and record it.
RUN git clone --filter=blob:none https://github.com/dora-rs/dora /src/dora \
    && cd /src/dora && git checkout "${DORA_COMMIT}" \
    && git rev-parse HEAD > /dora_commit.txt \
    && cat /dora_commit.txt

# Build the CLI first (warms the shared target cache for the maturin build),
# then the python extension wheel. Both come from the same commit/workspace.
WORKDIR /src/dora
RUN cargo build --release -p dora-cli --bin dora \
    && cp target/release/dora /dora-bin \
    && cd apis/python/node \
    && maturin build --release -i python3.12 --out /wheels \
    && ls -la /wheels /dora-bin

# ---------------------------------------------------------------------------
# Stage 2: deps (uv sync, repo-root context — same pattern as topic_monitor).
# ---------------------------------------------------------------------------
FROM ros:${ROS_DISTRO}-ros-base AS deps
COPY --from=ghcr.io/astral-sh/uv:0.10.0@sha256:78a7ff97cd27b7124a5f3c2aefe146170793c56a1e03321dd31a289f6d82a04f /uv /usr/local/bin/uv

# --system-site-packages keeps the ROS-provided rclpy importable (the control
# sidecar's graph poller uses it); dora-rs comes from the source-built wheel.
ENV VENV=/opt/venv \
    UV_PYTHON_PREFERENCE=only-system \
    UV_PROJECT_ENVIRONMENT=/opt/venv
RUN uv venv --python python3 --system-site-packages $VENV
ENV PATH="$VENV/bin:$PATH"

WORKDIR /app
COPY libs/kairos_common /app/libs/kairos_common
COPY services/dora_live /app/services/dora_live
RUN cd /app/services/dora_live \
    && uv sync --frozen --no-editable --no-dev

COPY --from=builder /wheels/ /tmp/wheels/
RUN VIRTUAL_ENV=/opt/venv uv pip install --python /opt/venv/bin/python /tmp/wheels/*.whl \
    && rm -rf /tmp/wheels

# ---------------------------------------------------------------------------
# Stage 3: runtime.
# ---------------------------------------------------------------------------
FROM ros:${ROS_DISTRO}-ros-base AS runtime
ENV DEBIAN_FRONTEND=noninteractive
ARG ROS_DISTRO

# rmw_cyclonedds: RMW is deploy-switchable; bridge interop is verified clean
# for both FastDDS (UDP) and Cyclone without extra profiles (cells A / report).
# ffmpeg-image-transport-msgs: ships FFMPEGPacket.msg so the bridge can resolve
# H.264/HEVC camera topics (the video lane's ffmpeg codec) on ANY robot without
# a per-robot msgs overlay; decode itself uses the PyAV wheel (no ffmpeg apt).
RUN apt-get update && apt-get install -y --no-install-recommends \
        ros-${ROS_DISTRO}-rmw-cyclonedds-cpp \
        ros-${ROS_DISTRO}-ffmpeg-image-transport-msgs \
    && rm -rf /var/lib/apt/lists/*

ENV VENV=/opt/venv
ENV PATH="$VENV/bin:$PATH"
COPY --from=deps /opt/venv /opt/venv
COPY --from=builder /dora-bin /opt/venv/bin/dora
COPY --from=builder /dora_commit.txt /dora_commit.txt
RUN chmod +x /opt/venv/bin/dora

COPY services/dora_live/entrypoint.sh /entrypoint.sh
COPY services/dora_live/run_node.sh /run_node.sh
RUN chmod +x /entrypoint.sh /run_node.sh

WORKDIR /app
ENTRYPOINT ["/entrypoint.sh"]
