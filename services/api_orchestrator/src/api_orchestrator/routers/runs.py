"""Run query endpoints (``/api/v1/runs``).

Cursor-paginated list and single-run lookup. The runs store (SQLite) is the
source of truth; these are read-only views over it.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from api_orchestrator.deps import get_run_service
from api_orchestrator.models import Run, RunListResponse
from api_orchestrator.runs import RunService

router = APIRouter(prefix="/api/v1/runs", tags=["runs"])

# Cursor pagination defaults/bounds (config.md: default limit 50).
DEFAULT_LIMIT = 50
MAX_LIMIT = 200


@router.get("", response_model=RunListResponse)
async def list_runs(
    service: RunService = Depends(get_run_service),
    limit: int = Query(DEFAULT_LIMIT, ge=1, le=MAX_LIMIT),
    cursor: str | None = Query(None),
) -> RunListResponse:
    """List runs newest-first with cursor pagination."""
    items, next_cursor = service.list_runs(limit, cursor)
    return RunListResponse(items=items, next_cursor=next_cursor)


@router.get("/{run_id}", response_model=Run)
async def get_run(
    run_id: str,
    service: RunService = Depends(get_run_service),
) -> Run:
    """Return a single run by id (404 if absent)."""
    return service.get(run_id)
