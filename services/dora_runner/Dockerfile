# syntax=docker/dockerfile:1
# dora_runner — reads MCAP files directly (mcap + mcap-ros2-support in Stage 3),
# so it needs no rclpy and is built FROM the slim Python image. Multi-stage:
# build a venv, copy only the venv into the runtime image.

# ---- builder ----------------------------------------------------------------
FROM python:3.12-slim AS builder
ENV VENV=/opt/venv
RUN python3 -m venv $VENV
ENV PATH="$VENV/bin:$PATH"

WORKDIR /app
COPY libs/kairos_common /app/libs/kairos_common
COPY services/dora_runner /app/services/dora_runner
RUN pip install --no-cache-dir ./libs/kairos_common ./services/dora_runner

# ---- runtime ----------------------------------------------------------------
FROM python:3.12-slim AS runtime
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
