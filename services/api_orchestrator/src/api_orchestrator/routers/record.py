"""Recording control endpoints (``/api/v1/record/*``).

``start`` and ``stop`` drive the run lifecycle through the
:class:`~api_orchestrator.runs.RunService`; ``status`` proxies the recorder.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from api_orchestrator.deps import get_run_service
from api_orchestrator.models import RecordStartRequest, Run
from api_orchestrator.runs import RunService

router = APIRouter(prefix="/api/v1/record", tags=["record"])


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
    """Stop the active recording and finalize the run as ``completed``."""
    return await service.stop()


@router.get("/status")
async def record_status(
    service: RunService = Depends(get_run_service),
) -> dict[str, Any]:
    """Proxy the recorder's ``GET /record/status``."""
    return await service.status()
