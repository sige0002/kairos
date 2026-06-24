# syntax=docker/dockerfile:1
# api_orchestrator — pure-Python API hub; no rclpy, so it is built FROM the
# slim Python image (not the heavy ROS base). Multi-stage: build a venv, copy
# only the venv into the runtime image.

# ---- builder ----------------------------------------------------------------
FROM python:3.12-slim AS builder
ENV VENV=/opt/venv
RUN python3 -m venv $VENV
ENV PATH="$VENV/bin:$PATH"

WORKDIR /app
COPY libs/kairos_common /app/libs/kairos_common
COPY services/api_orchestrator /app/services/api_orchestrator
RUN pip install --no-cache-dir ./libs/kairos_common ./services/api_orchestrator

# ---- runtime ----------------------------------------------------------------
FROM python:3.12-slim AS runtime
ENV VENV=/opt/venv
ENV PATH="$VENV/bin:$PATH"
COPY --from=builder /opt/venv /opt/venv

# Run as a non-root user (no devices/ROS graph needed here).
RUN useradd --create-home --uid 10001 appuser
USER appuser

# Public port from the shared .env (API_ORCH_PORT).
EXPOSE 8000

CMD ["python", "-m", "api_orchestrator.main"]
