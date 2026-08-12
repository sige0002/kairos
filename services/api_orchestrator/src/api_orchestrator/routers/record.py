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

from fastapi import APIRouter, Depends

from api_orchestrator.deps import get_record_service
from api_orchestrator.models import (
    Capture,
    RecordPrepareResponse,
    RecordStartRequest,
)
from api_orchestrator.record_service import RecordService

router = APIRouter(prefix="/api/v1/record", tags=["record"])


@router.post("/prepare", response_model=RecordPrepareResponse)
async def record_prepare(
    body: RecordStartRequest,
    service: RecordService = Depends(get_record_service),
) -> RecordPrepareResponse:
    """Arm a recording ahead of time so a later matching ``start`` is fast.

    No run row is created yet (see :class:`RecordPrepareResponse`); a
    following ``POST /record/start`` with the same topics/compression/
    split/QoS reuses the armed session (near-instant resume). A non-matching
    ``start``, or none at all, falls back to today's full synchronous start —
    the recorder auto-disarms the stale armed session on its own timeout.
    """
    return await service.prepare(body)


@router.post("/start", response_model=Capture)
async def record_start(
    body: RecordStartRequest,
    service: RecordService = Depends(get_record_service),
) -> Capture:
    """Start recording and file the capture the recorder minted.

    On a recorder rejection the capture is returned in ``failed`` state when
    the recorder named one; if it did not, the error propagates and the
    recorder's failed-start sidecar is what the next rebuild turns into a row
    (§3.4).
    """
    return await service.start(body)


@router.post("/stop", response_model=Capture)
async def record_stop(
    service: RecordService = Depends(get_record_service),
) -> Capture:
    """Stop the active recording and finalize the run as ``completed``.

    Also cancels a still-armed ``prepare`` (nothing started): the recorder is
    told to disarm rather than sitting armed — and holding its DDS
    subscriptions — until its own timeout. A cancelled prepare has no capture
    row, so the response is the same as any other no-op stop: the most recent
    capture, or ``404`` when nothing has ever been recorded.
    """
    return await service.stop()


@router.get("/status")
async def record_status(
    service: RecordService = Depends(get_record_service),
) -> dict[str, Any]:
    """Proxy the recorder's ``GET /record/status``."""
    return await service.status()
