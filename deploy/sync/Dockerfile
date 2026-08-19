# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89
# importer — recording-PC sidecar that pulls finalised runs from the robot
# (deploy/sync/import_runs.sh behind a tiny HTTP trigger, importer_httpd.py).
# Defined ONLY in compose/recording.yaml: the single-host stack (compose/compose.yaml)
# has the data locally and never runs this image.
#
# Reuses the repo's pinned slim Python base (already cached for
# api_orchestrator) purely as a pinned Debian with a stdlib Python — the
# sidecar is import_runs.sh + a stdlib-only HTTP daemon, no pip installs.
FROM python:3.12.13-slim@sha256:423ed6ab25b1921a477529254bfeeabf5855151dc2c3141699a1bfc852199fbf

# openssh-client + rsync do the pull; sshpass enables the ROBOT_SSH_PASSWORD
# auth path (password read from env, never argv).
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-client rsync sshpass \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY import_runs.sh importer_httpd.py /app/

# Runs as root ON PURPOSE (unlike the orchestrator's non-root appuser):
#  (i) a mounted ROBOT_SSH_KEY can stay 0600-owned by the HOST user — container
#      root reads it via DAC_OVERRIDE, and OpenSSH skips its "UNPROTECTED KEY"
#      mode check for identity files not owned by the calling uid;
# (ii) pulled run dirs land root-owned, exactly like recorder-written runs on a
#      single host — the orchestrator's delete path and dora already handle it.
CMD ["python3", "/app/importer_httpd.py"]
