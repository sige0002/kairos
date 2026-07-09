"""Recording control endpoints (``/api/v1/record/*``).

``prepare``, ``start``, and ``stop`` drive the run lifecycle through the
:class:`~api_orchestrator.runs.RunService`; ``status`` proxies the recorder.
``prepare`` is the two-phase-start optimization (arm ahead of time so a later
matching ``start`` is fast) — it is optional; ``start`` alone is unchanged for
any caller that never calls ``prepare`` first.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from api_orchestrator.deps import get_run_service
from api_orchestrator.models import RecordPrepareResponse, RecordStartRequest, Run
from api_orchestrator.runs import RunService

router = APIRouter(prefix="/api/v1/record", tags=["record"])


@router.post("/prepare", response_model=RecordPrepareResponse)
async def record_prepare(
    body: RecordStartRequest,
    service: RunService = Depends(get_run_service),
) -> RecordPrepareResponse:
    """Arm a recording ahead of time so a later matching ``start`` is fast.

    No run row is created yet (see :class:`RecordPrepareResponse`); a
    following ``POST /record/start`` with the same topics/compression/
    split/QoS reuses the armed session (near-instant resume). A non-matching
    ``start``, or none at all, falls back to today's full synchronous start —
    the recorder auto-disarms the stale armed session on its own timeout.
    """
    return await service.prepare(body)


@router.post("/start", response_model=Run)
async def record_start(
    body: RecordStartRequest,
    service: RunService = Depends(get_run_service),
) -> Run:
    """Allocate a run and start recording.

    On recorder failure the run row is kept and returned in ``failed`` state
    (the request itself still succeeds — the failure is recorded on the run).
    """
    return await service.start(body)


@router.post("/stop", response_model=Run)
async def record_stop(
    service: RunService = Depends(get_run_service),
) -> Run:
    """Stop the active recording and finalize the run as ``completed``.

    Also cancels a still-armed ``prepare`` (no run yet started): the recorder
    is told to disarm so it does not sit armed until its own auto-disarm
    timeout. There is no run row for a cancelled prepare, so the response is
    the same as any other no-op stop (the most recent run, or ``404`` if none
    has ever been recorded).
    """
    return await service.stop()


@router.get("/status")
async def record_status(
    service: RunService = Depends(get_run_service),
) -> dict[str, Any]:
    """Proxy the recorder's ``GET /record/status``."""
    return await service.status()
