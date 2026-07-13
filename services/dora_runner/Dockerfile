# syntax=docker/dockerfile:1
# dora_runner — reads MCAP files directly (mcap + mcap-ros2-support in Stage 3),
# so it needs no rclpy and is built FROM the slim Python image. Multi-stage:
# build a venv from the committed uv.lock, copy only the venv into the runtime.
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
ENV VENV=/opt/venv \
    UV_PYTHON_PREFERENCE=only-system \
    UV_PROJECT_ENVIRONMENT=/opt/venv
RUN uv venv --python python3 $VENV
ENV PATH="$VENV/bin:$PATH"

WORKDIR /app
COPY libs/kairos_common /app/libs/kairos_common
COPY services/dora_runner /app/services/dora_runner
# Install the exact locked dependency set (--frozen: no re-resolution) plus the
# local packages non-editable (--no-editable, so the copied venv has no .pth
# pointing back at this builder stage's /app). The lock's kairos-common path
# source (../../libs/kairos_common) resolves from the service dir.
RUN cd /app/services/dora_runner \
    && uv sync --frozen --no-editable --no-dev

# ---- runtime ----------------------------------------------------------------
FROM python:3.12.13-slim@sha256:423ed6ab25b1921a477529254bfeeabf5855151dc2c3141699a1bfc852199fbf AS runtime
ENV VENV=/opt/venv
ENV PATH="$VENV/bin:$PATH"
COPY --from=builder /opt/venv /opt/venv

# Drop-in plugins are loaded by path (not pip-installed into the package), so bake
# the directory in and point discovery at it. Adding a plugin = adding a folder
# here + rebuild (see plugins/README.md). The source-relative default in
# plugin_loader.default_plugins_dir() only resolves in editable/local runs, hence
# the explicit env in the image.
COPY services/dora_runner/plugins /app/plugins
ENV KAIROS_PLUGINS_DIR=/app/plugins

RUN useradd --create-home --uid 10001 appuser
USER appuser

# Internal service port. The value is sourced from settings.py (DORA_RUNNER_PORT,
# default 8020) at runtime; EXPOSE is metadata only. Do not set ENV
# DORA_RUNNER_PORT here — that would be a second default that can drift from
# settings.py / compose's ${DORA_RUNNER_PORT}.
EXPOSE 8020

CMD ["python", "-m", "dora_runner.main"]
