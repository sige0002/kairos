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
# The builder stage diverges from the benchmark image since the carried
# metrics patch below (no cross-image layer-cache sharing anymore).
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

# Pin the source to the requested commit, then apply the carried kairos patch:
# a Rust-side "metrics subscription" (drain-batched arrival/size/stamp rows +
# probe tap slot) that removes the per-message Python event boundary for
# feed-only bridges — the measured ~0.55 ms/event structural cost (see
# dev_docs/codex_dora_bottleneck.md). Upstream candidate; drop the patch once
# an equivalent ships in a dora release.
# Second carried patch: rustdds 0.11.4 -> 0.13.1 (+ ros2-client 0.10.0). The
# pinned dora ships a 16-month-old RustDDS whose FastDDS interop loses SEDP
# reader announcements under load (proven: FastDDS `Subscription count: 0`
# while the ingest participant is alive -> all topics 0 Hz until publisher
# restart); 0.12.0-0.13.1 (2026-06/07) carry the upstream interop fixes (SPDP
# response, QoS-matching logic, NACK_FRAG handling). Upstream dora keeps
# =0.11.4 only for a Windows-only pnet build issue (Atostek/RustDDS#375),
# which does not apply to this Linux image.
# Third carried patch: empty message types (std_msgs/Empty) panic dora's
# CDR->Arrow deserializer (StructArray::from(vec![]) is rejected by arrow),
# and that panic poisons the RustDDS cache mutex — the whole participant
# event loop dies and EVERY topic goes 0 Hz. Upstream dora bug (its defaults
# path tests already use new_empty_fields; the production paths don't).
COPY services/dora_live/dora-metrics.patch /dora-metrics.patch
COPY services/dora_live/dora-rustdds-bump.patch /dora-rustdds-bump.patch
COPY services/dora_live/dora-empty-struct-fix.patch /dora-empty-struct-fix.patch
RUN git clone --filter=blob:none https://github.com/dora-rs/dora /src/dora \
    && cd /src/dora && git checkout "${DORA_COMMIT}" \
    && git apply /dora-metrics.patch \
    && git apply /dora-rustdds-bump.patch \
    && git apply /dora-empty-struct-fix.patch \
    && git rev-parse HEAD > /dora_commit.txt \
    && echo "kairos-patch: dora-metrics" >> /dora_commit.txt \
    && echo "kairos-patch: dora-rustdds-bump (rustdds 0.13.1)" >> /dora_commit.txt \
    && echo "kairos-patch: dora-empty-struct-fix" >> /dora_commit.txt \
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
