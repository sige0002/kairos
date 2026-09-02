# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Recording control endpoints (``/api/v1/record/*``).

``prepare``, ``start``, and ``stop`` drive the capture lifecycle through the
:class:`~api_orchestrator.record_service.RecordService`; ``status`` proxies the
recorder. All four keep their v1 request/response shape and gain ``capture_id``
(§10) — the recorder mints it, and it is what every other v2 endpoint keys on.
``prepare`` is the two-phase-start optimization (arm ahead of time so a later
matching ``start`` is fast) — it is optional; ``start`` alone is unchanged for
any caller that never calls ``prepare`` first.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Request, Response

from api_orchestrator.deps import get_record_service
from api_orchestrator.models import (
    Capture,
    RecordPrepareResponse,
    RecordStartRequest,
    RecordStopRequest,
)
from api_orchestrator.record_control import CONTROL_COOKIE, RecordControlService
from api_orchestrator.record_service import RecordService

router = APIRouter(prefix="/api/v1/record", tags=["record"])


@router.post("/prepare", response_model=RecordPrepareResponse)
async def record_prepare(
    body: RecordStartRequest,
    request: Request,
    service: RecordService = Depends(get_record_service),
) -> RecordPrepareResponse:
    """Arm a recording ahead of time so a later matching ``start`` is fast.

    No run row is created yet (see :class:`RecordPrepareResponse`); a
    following ``POST /record/start`` with the same topics/compression/
    split/QoS reuses the armed session (near-instant resume). A non-matching
    ``start``, or none at all, falls back to today's full synchronous start —
    the recorder auto-disarms the stale armed session on its own timeout.
    """
    audio = request.app.state.audio_feedback
    audio.reserve_for_recording()
    try:
        return await service.prepare(body)
    finally:
        audio.release_recording_reservation()


@router.post("/start", response_model=Capture)
async def record_start(
    body: RecordStartRequest,
    request: Request,
    response: Response,
    service: RecordService = Depends(get_record_service),
) -> Capture:
    """Start recording and file the capture the recorder minted.

    On a recorder rejection the capture is returned in ``failed`` state when
    the recorder named one; if it did not, the error propagates and the
    recorder's failed-start sidecar is what the next rebuild turns into a row
    (§3.4).
    """
    audio = request.app.state.audio_feedback
    audio.reserve_for_recording()
    try:
        control: RecordControlService = request.app.state.record_control
        # Start and lease issuance form one operation.  Without this, a
        # force-stop could run after the recorder starts but before this
        # browser is issued its controller cookie.
        async with control.operation_lock:
            capture = await service.start(body)
            if capture.capture_id and str(capture.state) == "recording":
                token: str = control.issue_for_start(capture.capture_id)
                # Session cookie: reloads retain control but closing the browser
                # session does not create a durable credential.  It is HttpOnly
                # so page scripts never need to read or persist the token.
                response.set_cookie(
                    CONTROL_COOKIE,
                    token,
                    httponly=True,
                    samesite="lax",
                    path="/api/v1/record",
                )
        return capture
    finally:
        audio.release_recording_reservation()


@router.post("/stop", response_model=Capture)
async def record_stop(
    body: RecordStopRequest,
    request: Request,
    service: RecordService = Depends(get_record_service),
) -> Capture:
    """Normally stop the named recording owned by this browser session.

    A pre-armed session has no browser-owned capture yet and is deliberately
    not a normal-stop target.  Recorder maintenance/reconciliation uses the
    separate system-stop boundary to disarm it when necessary.
    """
    control: RecordControlService = request.app.state.record_control
    async with control.operation_lock:
        control.require(body.capture_id, request.cookies.get(CONTROL_COOKIE))
        # Retain this terminal capture's lease until the next start overwrites
        # it. If the successful response is lost, the same browser can safely
        # retry this capture-bound idempotent stop instead of receiving 409.
        return await service.stop_capture(body.capture_id)


@router.post("/takeover")
async def record_takeover(
    body: RecordStopRequest,
    request: Request,
    response: Response,
    service: RecordService = Depends(get_record_service),
) -> dict[str, object]:
    """Explicitly transfer control of the live named capture to this browser."""
    control: RecordControlService = request.app.state.record_control
    async with control.operation_lock:
        await service.ensure_active_capture(body.capture_id)
        token = control.take_over(body.capture_id)
    response.set_cookie(
        CONTROL_COOKIE,
        token,
        httponly=True,
        samesite="lax",
        path="/api/v1/record",
    )
    return {
        "capture_id": body.capture_id,
        "controlled_by_this_client": True,
        "lease_known": True,
    }


@router.post("/force-stop", response_model=Capture)
async def record_force_stop(
    body: RecordStopRequest,
    request: Request,
    service: RecordService = Depends(get_record_service),
) -> Capture:
    """Emergency recovery stop for a named live capture, bypassing a lease.

    This remains a trusted-LAN operational escape hatch.  The UI requires a
    separate confirmation and labels it as emergency recovery; it is not the
    normal Stop action.
    """
    control: RecordControlService = request.app.state.record_control
    async with control.operation_lock:
        capture = await service.stop_capture(body.capture_id)
        control.clear_if(capture.capture_id)
        return capture


@router.get("/status")
async def record_status(
    request: Request,
    service: RecordService = Depends(get_record_service),
) -> dict[str, Any]:
    """Proxy the recorder's ``GET /record/status``."""
    status = await service.status()
    active_capture = status.get("capture_id")
    if status.get("state") not in {"recording", "stopping"}:
        active_capture = None
    status["control"] = request.app.state.record_control.status(
        active_capture if isinstance(active_capture, str) else None,
        request.cookies.get(CONTROL_COOKIE),
    )
    return status
