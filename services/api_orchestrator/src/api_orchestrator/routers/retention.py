"""Retention endpoint (``GET /api/v1/retention``).

Surfaces the recordings that ``RETENTION_DAYS`` marks as old-and-unexported so
the Review UI can nudge the operator to reclaim them. Per the 2026-07-14
adjudication this feature is deliberately *advisory only*: it NEVER deletes
anything and runs no background job. Candidates are computed on request (cheap:
the runs table plus best-effort directory sizes), and deletion always goes
through the existing confirmed ``DELETE /api/v1/runs/{id}`` path. Exported
datasets (whose run row is gone) are untouchable and never appear here.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from api_orchestrator.deps import get_run_service
from api_orchestrator.models import RetentionResponse
from api_orchestrator.runs import RunService

router = APIRouter(prefix="/api/v1/retention", tags=["retention"])


@router.get("", response_model=RetentionResponse)
async def get_retention(
    request: Request,
    service: RunService = Depends(get_run_service),
) -> RetentionResponse:
    """Return the current retention candidates and their total size.

    ``RETENTION_DAYS <= 0`` disables the feature (``days`` echoes the setting and
    the candidate set is empty).
    """
    retention_days = request.app.state.settings.retention_days
    candidates, total_bytes = service.retention_candidates(retention_days)
    return RetentionResponse(
        days=retention_days, candidates=candidates, total_bytes=total_bytes
    )
