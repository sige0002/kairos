# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89
# Digest-pinned on purpose: an unpinned tag makes BuildKit resolve it against the
# registry on EVERY build, which fails where there is no network (robot in the field).
# lerobot_exporter — the resident LeRobot v3 export service. It installs the
# SITE-PROVIDED rosbag2lerobot converter (deploy/lerobot/converter, a gitignored
# tree each site supplies — see deploy/lerobot/README.md) and runs it as a
# subprocess per export; the FastAPI wrapper itself stays thin.
#
# Two things the converter needs that the wrapper does not:
#   - ffmpeg, as an external BINARY (the converter shells out to it per camera
#     stream), so it is an apt package rather than a Python wheel.
#   - its own dependency set, which is the converter's business — installed from
#     deploy/lerobot/converter at build time rather than pinned a second time in
#     this service's uv.lock.
#
# Base image pinned by patch tag + digest so a rebuild resolves the same bytes.
# 3.12 (not the 3.11 the converter's own floor allows) because kairos_common —
# shared by every service here — requires >= 3.12.

# ---- builder ----------------------------------------------------------------
FROM python:3.12.13-slim@sha256:423ed6ab25b1921a477529254bfeeabf5855151dc2c3141699a1bfc852199fbf AS builder
COPY --from=ghcr.io/astral-sh/uv:0.10.0@sha256:78a7ff97cd27b7124a5f3c2aefe146170793c56a1e03321dd31a289f6d82a04f /uv /usr/local/bin/uv

# UV_PYTHON_PREFERENCE=only-system + a bare "python3" keep uv from downloading a
# standalone Python (whose path would not exist in the runtime stage).
# UV_HTTP_TIMEOUT: uv's default 30 s READ timeout kills a build on a congested
# link; 600 s rides out stalls and a healthy link never notices.
ENV VENV=/opt/venv \
    UV_PYTHON_PREFERENCE=only-system \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_HTTP_TIMEOUT=600 \
    UV_HTTP_RETRIES=5
RUN uv venv --python python3 $VENV
ENV PATH="$VENV/bin:$PATH"

WORKDIR /app
COPY libs/kairos_common /app/libs/kairos_common
COPY services/lerobot_exporter/pyproject.toml services/lerobot_exporter/uv.lock /app/services/lerobot_exporter/
COPY services/lerobot_exporter/src /app/services/lerobot_exporter/src
# The service's own locked dependency set (--frozen: no re-resolution), local
# packages non-editable so the copied venv has no .pth pointing back at /app.
RUN cd /app/services/lerobot_exporter \
    && uv sync --frozen --no-editable --no-dev

# The site-provided converter, installed into the same venv. Copied and resolved
# separately from the lock above: its dependencies are the converter's own, and
# duplicating them in this service's lock would create a second place to update.
# From deploy/lerobot/converter (gitignored, site-supplied) — a build here fails
# fast with "COPY failed" if it was not populated; deploy/lerobot/README.md and
# `make build` both say how.
COPY deploy/lerobot/converter /app/rosbag2lerobot
RUN uv pip install --python $VENV /app/rosbag2lerobot

# ---- runtime ----------------------------------------------------------------
FROM python:3.12.13-slim@sha256:423ed6ab25b1921a477529254bfeeabf5855151dc2c3141699a1bfc852199fbf AS runtime
# ffmpeg is the converter's video encoder, spawned as a child process — a
# missing binary here surfaces as a failed export, not a failed build.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

ENV VENV=/opt/venv
ENV PATH="$VENV/bin:$PATH"
# Unbuffered: the converter's stdout/stderr are drained into the export's
# failure message, and a buffered child says nothing until it is too late.
ENV PYTHONUNBUFFERED=1
COPY --from=builder /opt/venv /opt/venv

RUN useradd --create-home --uid 10001 appuser
USER appuser

# Internal service port. The value is sourced from settings.py
# (LEROBOT_EXPORTER_PORT, default 8040) at runtime; EXPOSE is metadata only. Do
# not set ENV LEROBOT_EXPORTER_PORT here — that would be a second default that
# can drift from settings.py / compose's ${LEROBOT_EXPORTER_PORT}.
EXPOSE 8040

CMD ["python", "-m", "lerobot_exporter.main"]

# Build identity (compose passes it through the shared build-args anchor; make
# derives it, '-dirty' on an uncommitted tree). Declared LAST on purpose: a new
# commit then rebuilds only this metadata layer, not the stage above it.
ARG KAIROS_GIT_SHA=unknown
ENV KAIROS_GIT_SHA=$KAIROS_GIT_SHA
