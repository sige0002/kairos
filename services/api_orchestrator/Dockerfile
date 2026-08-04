# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89
# Digest-pinned on purpose: an unpinned tag makes BuildKit resolve it against the
# registry on EVERY build, which fails where there is no network (robot in the field).
# api_orchestrator — pure-Python API hub; no rclpy, so it is built FROM the
# slim Python image (not the heavy ROS base). Multi-stage: build a venv from the
# committed uv.lock, copy only the venv into the runtime image.
#
# Base images are pinned by patch tag + digest so a rebuild resolves the exact
# same bytes (see the "Releases" section in README). Dependencies come from the
# committed uv.lock via `uv sync --frozen` — no `>=` re-resolution at build time.

# ---- builder ----------------------------------------------------------------
FROM python:3.12.13-slim@sha256:423ed6ab25b1921a477529254bfeeabf5855151dc2c3141699a1bfc852199fbf AS builder
COPY --from=ghcr.io/astral-sh/uv:0.10.0@sha256:78a7ff97cd27b7124a5f3c2aefe146170793c56a1e03321dd31a289f6d82a04f /uv /usr/local/bin/uv

# UV_PYTHON_PREFERENCE=only-system + a bare "python3" keep uv from downloading a
# standalone Python (whose path would not exist in the runtime stage). The venv
# lives at UV_PROJECT_ENVIRONMENT so `uv sync` installs into it.
# UV_HTTP_TIMEOUT: uv's default is a 30 s READ timeout — a >30 s no-byte stall
# (congested field Wi-Fi / cellular) kills the download, and the build with it.
# 600 s rides out stalls; a healthy link never notices (read, not total, time).
ENV VENV=/opt/venv \
    UV_PYTHON_PREFERENCE=only-system \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_HTTP_TIMEOUT=600 \
    UV_HTTP_RETRIES=5
RUN uv venv --python python3 $VENV
ENV PATH="$VENV/bin:$PATH"

WORKDIR /app
COPY libs/kairos_common /app/libs/kairos_common
COPY services/api_orchestrator /app/services/api_orchestrator
# Install the exact locked dependency set (--frozen: no re-resolution) plus the
# local packages non-editable (--no-editable, so the copied venv has no .pth
# pointing back at this builder stage's /app). The lock's kairos-common path
# source (../../libs/kairos_common) resolves from the service dir.
RUN cd /app/services/api_orchestrator \
    && uv sync --frozen --no-editable --no-dev

# ---- runtime ----------------------------------------------------------------
FROM python:3.12.13-slim@sha256:423ed6ab25b1921a477529254bfeeabf5855151dc2c3141699a1bfc852199fbf AS runtime
ENV VENV=/opt/venv
ENV PATH="$VENV/bin:$PATH"
COPY --from=builder /opt/venv /opt/venv

# Run as a non-root user (no devices/ROS graph needed here).
RUN useradd --create-home --uid 10001 appuser
USER appuser

# Public port from the shared .env (API_ORCH_PORT).
EXPOSE 8000

CMD ["python", "-m", "api_orchestrator.main"]

# Build identity (compose passes it through the shared build-args anchor; make
# derives it, '-dirty' on an uncommitted tree). Declared LAST on purpose: a new
# commit then rebuilds only this metadata layer, not the stage above it.
ARG KAIROS_GIT_SHA=unknown
ENV KAIROS_GIT_SHA=$KAIROS_GIT_SHA
