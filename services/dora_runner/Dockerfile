# syntax=docker/dockerfile:1
# dora_runner — reads MCAP files directly (mcap + mcap-ros2-support in Stage 3),
# so it needs no rclpy and is built FROM the slim Python image. Multi-stage:
# build a venv from the committed uv.lock, copy only the venv into the runtime.
#
# It ALSO carries the real dora runtime for the validation pipelines
# (`fast_validation` / `full_validation`): the vendored bagflow workspace
# (services/dora_runner/bagflow, see its VENDOR.md)
# compiles to the CLI + source/report/decode/check node binaries, and the dora
# CLI release binary provides `dora coordinator/daemon/start/stop`. dora keeps
# every queued message in /dev/shm, so the container needs `shm_size` well above
# Docker's 64 MB default — compose sets it; a node that runs out dies without
# writing a single log line.
#
# Base images are pinned by patch tag + digest so a rebuild resolves the exact
# same bytes (see the "Releases" section in README). Dependencies come from the
# committed uv.lock via `uv sync --frozen` (Python) and Cargo.lock (Rust) — no
# `>=` re-resolution at build time.

# ---- builder ----------------------------------------------------------------
FROM python:3.12.13-slim@sha256:423ed6ab25b1921a477529254bfeeabf5855151dc2c3141699a1bfc852199fbf AS builder
COPY --from=ghcr.io/astral-sh/uv:0.10.0@sha256:78a7ff97cd27b7124a5f3c2aefe146170793c56a1e03321dd31a289f6d82a04f /uv /usr/local/bin/uv

# UV_PYTHON_PREFERENCE=only-system + a bare "python3" keep uv from downloading a
# standalone Python (whose path would not exist in the runtime stage). The venv
# lives at UV_PROJECT_ENVIRONMENT so `uv sync` installs into it.
ENV VENV=/opt/venv \
    UV_PYTHON_PREFERENCE=only-system \
    UV_PROJECT_ENVIRONMENT=/opt/venv
RUN uv venv --python python3 $VENV
ENV PATH="$VENV/bin:$PATH"

WORKDIR /app
COPY libs/kairos_common /app/libs/kairos_common
# Only what the Python build needs: the vendored Rust tree lives in the same
# service dir, and copying it here would rebuild the venv on every Rust edit.
COPY services/dora_runner/pyproject.toml services/dora_runner/uv.lock /app/services/dora_runner/
COPY services/dora_runner/src /app/services/dora_runner/src
# Install the exact locked dependency set (--frozen: no re-resolution) plus the
# local packages non-editable (--no-editable, so the copied venv has no .pth
# pointing back at this builder stage's /app). The lock's kairos-common path
# source (../../libs/kairos_common) resolves from the service dir.
RUN cd /app/services/dora_runner \
    && uv sync --frozen --no-editable --no-dev

# ---- bagflow builder (Rust nodes + the dora CLI) ----------------------------
# Separate stage so a Python-only change never recompiles Rust and vice versa.
# rustc is pinned to the version the vendored workspace was verified against.
FROM rust:1.97.1-bookworm@sha256:77fac8b98f9f46062bb680b6d25d5bcaabfc400143952ebc572e924bcbedc3fa AS bagflow-builder
# bagflow-decode links against libjpeg-turbo. turbojpeg-sys builds it from
# source (cmake + a SIMD assembler: NEON needs only the C compiler, x86 SIMD
# needs nasm) and links it statically, so the runtime image carries no
# libturbojpeg dependency of its own; the -dev package + pkg-config are kept so
# the crate can pick the system library up if a future version prefers it.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libturbojpeg0-dev pkg-config cmake \
        $(if [ "$(uname -m)" = "x86_64" ]; then echo nasm; fi) \
    && rm -rf /var/lib/apt/lists/*

# The dora CLI must match the dora-node-api version the nodes link against
# (0.5) — the coordinator/daemon protocol is not compatible across versions.
# DORA_CLI_URL is overridable so a locked-down site can point at a mirror.
ARG DORA_VERSION=0.5.0
ARG DORA_CLI_URL=
RUN ARCH=$(uname -m) \
    && URL="${DORA_CLI_URL:-https://github.com/dora-rs/dora/releases/download/v${DORA_VERSION}/dora-cli-${ARCH}-unknown-linux-gnu.tar.gz}" \
    && curl -fsSL "$URL" | tar xz -C /tmp \
    && mv "/tmp/dora-cli-${ARCH}-unknown-linux-gnu/dora" /usr/local/bin/dora \
    && rm -rf "/tmp/dora-cli-${ARCH}-unknown-linux-gnu" \
    && dora --version

WORKDIR /bagflow
COPY services/dora_runner/bagflow /bagflow
RUN cargo build --release --locked \
    && mkdir -p /out \
    && cp target/release/bagflow \
          target/release/bagflow-source \
          target/release/bagflow-report \
          target/release/bagflow-decode \
          target/release/bagflow-blur \
          target/release/bagflow-brightness \
          target/release/bagflow-freeze \
          target/release/bagflow-stamp-gap \
          target/release/bagflow-topic-rate \
          target/release/bagflow-topic-presence \
          /out/

# ---- runtime ----------------------------------------------------------------
FROM python:3.12.13-slim@sha256:423ed6ab25b1921a477529254bfeeabf5855151dc2c3141699a1bfc852199fbf AS runtime
ENV VENV=/opt/venv
ENV PATH="$VENV/bin:$PATH"
COPY --from=builder /opt/venv /opt/venv

# No extra runtime libs: libjpeg-turbo is linked statically into bagflow-decode
# (verified with ldd — nothing jpeg-related is resolved dynamically), and the
# dora CLI is a self-contained release binary.
COPY --from=bagflow-builder /usr/local/bin/dora /usr/local/bin/dora
COPY --from=bagflow-builder /out/ /usr/local/bin/

# Drop-in plugins are loaded by path (not pip-installed into the package), so bake
# the directory in and point discovery at it. Adding a plugin = adding a folder
# here + rebuild (see plugins/README.md). The source-relative default in
# plugin_loader.default_plugins_dir() only resolves in editable/local runs, hence
# the explicit env in the image.
COPY services/dora_runner/plugins /app/plugins
ENV KAIROS_PLUGINS_DIR=/app/plugins

# Flows shipped with the service. fast_validation must work on a robot whose
# operator never authored a flow, so its bagflow flow lives here rather than in
# config/<robot>/flows/ — where a file of the same name still overrides it
# (bagflow_flow.resolve_flow searches the robot's dir first).
COPY services/dora_runner/flows /opt/kairos/flows

RUN useradd --create-home --uid 10001 appuser
USER appuser

# Internal service port. The value is sourced from settings.py (DORA_RUNNER_PORT,
# default 8020) at runtime; EXPOSE is metadata only. Do not set ENV
# DORA_RUNNER_PORT here — that would be a second default that can drift from
# settings.py / compose's ${DORA_RUNNER_PORT}.
EXPOSE 8020

CMD ["python", "-m", "dora_runner.main"]
