"""Retention endpoint (``GET /api/v1/retention``).

Surfaces the captures ``RETENTION_DAYS`` marks as reclaimable so the Review UI
can nudge the operator. Deliberately *advisory only*: it NEVER deletes anything
and runs no background job, and deletion always goes through the confirmed
``POST /api/v1/captures/{id}/delete`` path.

§10 redefines what a candidate is. The v1 rule — "a row still exists, therefore
it was never exported" — is meaningless now that §6 keeps the row forever, so a
candidate is a capture that no dataset cites, whose review left it ``pending``
or ``excluded``, and which is older than the retention period.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from api_orchestrator.captures import CaptureService
from api_orchestrator.deps import get_capture_service
from api_orchestrator.models import RetentionResponse

router = APIRouter(prefix="/api/v1/retention", tags=["retention"])


@router.get("", response_model=RetentionResponse)
async def get_retention(
    request: Request,
    service: CaptureService = Depends(get_capture_service),
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
