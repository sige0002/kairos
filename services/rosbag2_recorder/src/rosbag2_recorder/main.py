# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""rosbag2_recorder service entry point (Stage 1).

ROS 2 topics -> MCAP, the canonical recording path. This module wires the
recording session manager (:mod:`rosbag2_recorder.recorder`) to the internal
HTTP API consumed by ``api_orchestrator`` (not public): start/stop/status and
metadata. Cross-cutting plumbing (health, error shape, CORS, logging) comes from
``kairos_common.create_app``. See ``docs/specs/ja/rosbag2_recorder.md``.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI, Response
from kairos_common import (
    create_app,
    get_settings,
    load_recording_config_or_none,
    resolve_config_path,
)

from rosbag2_recorder.models import (
    RecordDisarmRequest,
    RecordDisarmResponse,
    RecordPrepareRequest,
    RecordPrepareResponse,
    RecordStartRequest,
    RecordStartResponse,
    RecordStatusResponse,
)
from rosbag2_recorder.recorder import RecorderSession

logger = logging.getLogger("kairos.rosbag2_recorder")

SERVICE_NAME = "rosbag2_recorder"


def create_recorder_app() -> FastAPI:
    """Build the recorder FastAPI app with the session and routes wired in."""
    settings = get_settings()
    # The per-topic QoS overrides come from this file; without it the recorder
    # still works (rosbag2 follows each publisher's offered QoS).
    config = load_recording_config_or_none(
        resolve_config_path(settings.recording_config), logger
    )
    session = RecorderSession(settings, config)
    session.reconcile_on_startup()

    # Readiness reflects that the recorder can write to /data; if the recorded
    # root is not usable we are live but not ready. A plain ``def`` so Starlette
    # runs it in its thread pool (``ensure_ready`` touches the filesystem) — the
    # same reason the record routes below are sync.
    def readyz(response: Response) -> dict[str, str]:
        try:
            session.ensure_ready()
        except Exception:  # noqa: BLE001 - report unready, never crash the probe
            response.status_code = 503
            return {"status": "not_ready"}
        return {"status": "ready"}

    app = create_app(SERVICE_NAME, settings=settings, readyz=readyz)
    app.state.session = session

    # These routes are declared with a plain ``def`` (not ``async def``) on
    # purpose: ``session.start``/``stop`` block synchronously (the start delay +
    # arming gate, and the up-to-30s wait for the bag process to exit on stop).
    # Starlette runs a sync endpoint in its thread pool but an ``async`` one
    # directly on the event loop, so an ``async`` handler here would freeze every
    # request — ``/healthz`` and ``/record/status`` included — for the whole
    # blocking span. None of these handlers await, so a plain ``def`` is correct.
    @app.post("/record/prepare", status_code=201, response_model=RecordPrepareResponse)
    def record_prepare(request: RecordPrepareRequest) -> RecordPrepareResponse:
        return session.prepare(request)

    @app.post("/record/start", status_code=201, response_model=RecordStartResponse)
    def record_start(request: RecordStartRequest) -> RecordStartResponse:
        status = session.start(request)
        return RecordStartResponse(
            run_id=status.run_id or request.run_id,
            # Always set on a successful start (the session commits it before
            # the status is built), so the empty string is unreachable rather
            # than a fallback anyone should read.
            capture_id=status.capture_id or "",
            state=status.state,
            started_at=status.started_at or "",
            # Settled arming snapshot (OL-①.4) so the orchestrator can forward it
            # on the record_status SSE event without a second /record/status call.
            arming=status.arming,
        )

    @app.post("/record/stop", response_model=RecordStatusResponse)
    def record_stop() -> RecordStatusResponse:
        return session.stop()

    @app.post("/record/disarm", response_model=RecordDisarmResponse)
    def record_disarm(request: RecordDisarmRequest) -> RecordDisarmResponse:
        """Conditionally release an exact unstarted armed session."""
        return session.disarm_if_armed(request.expected_capture_id)

    @app.get("/record/status", response_model=RecordStatusResponse)
    def record_status() -> RecordStatusResponse:
        return session.status()

    @app.get("/record/preflight")
    def record_preflight() -> dict[str, bool]:
        """Run the same storage/RAM checks as start, without recording.

        This is intentionally an explicit diagnostic endpoint rather than an
        automatic background probe. ``ApiError`` is allowed through so the
        orchestrator can show the exact blocker and evidence to the operator.
        """
        session.ensure_ready()
        return {"ready": True}

    @app.get("/record/metadata")
    def record_metadata() -> dict[str, Any]:
        return session.get_metadata()

    return app


app = create_recorder_app()


def main() -> None:
    """Run the service with uvicorn, binding host/port from config."""
    import uvicorn

    settings = get_settings()
    uvicorn.run(app, host=settings.bind_host, port=settings.recorder_port)


if __name__ == "__main__":
    main()
