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
    load_recording_config,
)

from rosbag2_recorder.models import (
    RecordStartRequest,
    RecordStartResponse,
    RecordStatusResponse,
)
from rosbag2_recorder.recorder import RecorderSession

logger = logging.getLogger("kairos.rosbag2_recorder")

SERVICE_NAME = "rosbag2_recorder"


def _load_config(recording_config_path: str) -> Any:
    """Load the RECORDING_CONFIG, tolerating its absence.

    The per-topic QoS overrides come from this file; if it is missing or
    invalid the recorder still works (rosbag2 follows each publisher's offered
    QoS), so we log and continue rather than refusing to boot.
    """
    try:
        return load_recording_config(recording_config_path)
    except (FileNotFoundError, ValueError) as exc:
        logger.warning("recording config unavailable: %s", exc)
        return None


def create_recorder_app() -> FastAPI:
    """Build the recorder FastAPI app with the session and routes wired in."""
    settings = get_settings()
    config = _load_config(settings.recording_config)
    session = RecorderSession(settings, config)
    session.reconcile_on_startup()

    app = create_app(SERVICE_NAME, settings=settings)
    app.state.session = session

    # create_app registers a default always-ready /readyz; drop it so our
    # dependency-aware probe below is the one that serves the path (Starlette
    # matches the first registered route, so the default would otherwise win).
    app.router.routes = [
        route
        for route in app.router.routes
        if getattr(route, "path", None) != "/readyz"
    ]

    # These routes are declared with a plain ``def`` (not ``async def``) on
    # purpose: ``session.start``/``stop`` block synchronously (the start delay +
    # arming gate, and the up-to-30s wait for the bag process to exit on stop).
    # Starlette runs a sync endpoint in its thread pool but an ``async`` one
    # directly on the event loop, so an ``async`` handler here would freeze every
    # request — ``/healthz`` and ``/record/status`` included — for the whole
    # blocking span. None of these handlers await, so a plain ``def`` is correct.
    @app.post("/record/start", status_code=201, response_model=RecordStartResponse)
    def record_start(request: RecordStartRequest) -> RecordStartResponse:
        status = session.start(request)
        return RecordStartResponse(
            run_id=status.run_id or request.run_id,
            state=status.state,
            started_at=status.started_at or "",
            # Settled arming snapshot (OL-①.4) so the orchestrator can forward it
            # on the record_status SSE event without a second /record/status call.
            arming=status.arming,
        )

    @app.post("/record/stop", response_model=RecordStatusResponse)
    def record_stop() -> RecordStatusResponse:
        return session.stop()

    @app.get("/record/status", response_model=RecordStatusResponse)
    def record_status() -> RecordStatusResponse:
        return session.status()

    @app.get("/record/metadata")
    def record_metadata() -> dict[str, Any]:
        return session.get_metadata()

    # Readiness reflects that the recorder can write to /data; if the recorded
    # root is not usable we are live but not ready. Sync ``def`` for the same
    # reason as the record routes (``ensure_ready`` may touch the filesystem).
    @app.get("/readyz", tags=["health"])
    def readyz(response: Response) -> dict[str, str]:
        try:
            session.ensure_ready()
        except Exception:  # noqa: BLE001 - report unready, never crash the probe
            response.status_code = 503
            return {"status": "not_ready"}
        return {"status": "ready"}

    return app


app = create_recorder_app()


def main() -> None:
    """Run the service with uvicorn, binding host/port from config."""
    import uvicorn

    settings = get_settings()
    uvicorn.run(app, host=settings.bind_host, port=settings.recorder_port)


if __name__ == "__main__":
    main()
