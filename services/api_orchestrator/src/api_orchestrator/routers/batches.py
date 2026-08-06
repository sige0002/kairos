"""Batch endpoints (``/api/v1/batches``) — Collect's grouping of captures.

A batch groups the captures recorded in one run of a task/condition. Under v2
there is no ``episodes`` resource: a capture *is* the episode, so a batch's
members are simply the captures carrying its ``batch_id`` (§8), which the first
review save stamps on (§4.1).

What used to be ``POST /api/v1/episodes`` is retired. Its two side effects moved
to the first review save for a capture: the monotone ``episodes_recorded``
counter and the split-deployment auto-pull. That move is what makes "reviewed"
and "counted" one event instead of two that could disagree after a crash.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from fastapi import APIRouter, Query, Request, status
from kairos_common import ApiError, utc_now_iso8601

from api_orchestrator.batch_service import BatchService
from api_orchestrator.models import (
    Batch,
    BatchCreateRequest,
    BatchDetail,
    BatchListResponse,
    BatchPatchRequest,
    BatchSummary,
)
from api_orchestrator.store import BatchExistsError, CaptureStore

logger = logging.getLogger("kairos")

router = APIRouter(prefix="/api/v1/batches", tags=["batches"])

# Batch statuses whose entry stamps ``ended_at`` (a batch is done once).
_TERMINAL_BATCH_STATUSES = {"completed", "ended_early"}

# Bound on suffix-retries when an allocated batch_id collides (same-second
# starts). One retry practically always suffices.
_MAX_BATCH_ID_ATTEMPTS = 50


def _store(request: Request) -> CaptureStore:
    return request.app.state.capture_store


def _service(request: Request) -> BatchService:
    return request.app.state.batch_service


def _allocate_batch_id(now: datetime | None = None) -> str:
    """``batch_YYYYMMDD_HHMMSS`` — same shape as a run id, display only."""
    moment = now or datetime.now(UTC)
    return moment.strftime("batch_%Y%m%d_%H%M%S")


def _default_robot(request: Request, robot: str | None) -> str | None:
    if robot is not None:
        return robot
    catalog = getattr(request.app.state, "config_catalog", None)
    return catalog.active_robot() if catalog is not None else None


def _summary(store: CaptureStore, batch: Batch) -> BatchSummary:
    """One batch's list item. The count is a query; the roster is not here."""
    counts = store.live_capture_counts([batch.batch_id])
    return BatchSummary(
        **batch.model_dump(), episode_count=counts.get(batch.batch_id, 0)
    )


@router.post("", response_model=Batch, status_code=status.HTTP_201_CREATED)
async def create_batch(request: Request, body: BatchCreateRequest) -> Batch:
    """Start a batch. ``robot`` defaults to the orchestrator's active robot."""
    now = utc_now_iso8601()
    base = _allocate_batch_id()
    for attempt in range(_MAX_BATCH_ID_ATTEMPTS):
        batch = Batch(
            batch_id=base if attempt == 0 else f"{base}_{attempt}",
            robot=_default_robot(request, body.robot),
            project=body.project,
            task=body.task,
            condition=body.condition,
            operator=body.operator,
            target_episodes=body.target_episodes,
            status="active",
            created_at=now,
        )
        try:
            return _service(request).create(batch)
        except BatchExistsError:
            continue
    raise ApiError(
        status_code=409,
        code="batch_id_unavailable",
        message="Could not allocate a unique batch_id; retry shortly.",
    )


@router.patch("/{batch_id}", response_model=Batch)
async def patch_batch(
    request: Request, batch_id: str, body: BatchPatchRequest
) -> Batch:
    """Update a batch: early stop, or a project/task/condition relabel.

    Entering a terminal status stamps ``ended_at`` once. ``project``/``task`` are
    patchable for the empty-batch case: Collect relabels a not-yet-recorded
    batch in place when the operator switches before the first recording.
    """
    store = _store(request)
    batch = store.get_batch(batch_id)
    if batch is None:
        raise _not_found(batch_id)
    fields: dict[str, object] = {
        name: value
        for name, value in (
            ("status", body.status),
            ("ended_reason", body.ended_reason),
            ("project", body.project),
            ("task", body.task),
            ("condition", body.condition),
            ("target_episodes", body.target_episodes),
        )
        if value is not None
    }
    if body.status in _TERMINAL_BATCH_STATUSES and batch.ended_at is None:
        fields["ended_at"] = utc_now_iso8601()
    try:
        return _service(request).update(batch_id, fields)
    except KeyError as exc:  # deleted between the read and the write
        raise _not_found(batch_id) from exc


@router.get("", response_model=BatchListResponse)
async def list_batches(
    request: Request,
    status: str | None = Query(None),
    robot: str | None = Query(None),
    operator: str | None = Query(None),
) -> BatchListResponse:
    """List batches newest-first with their capture counts and summaries.

    The filters scope Collect's active-batch restore, so one terminal never
    silently adopts (and appends captures to) another robot's or operator's
    batch.
    """
    store = _store(request)
    batches = store.list_batches(status, robot=robot, operator=operator)
    # One grouped query for every count, rather than one query per batch.
    counts = store.live_capture_counts([b.batch_id for b in batches])
    return BatchListResponse(
        items=[
            BatchSummary(**b.model_dump(), episode_count=counts.get(b.batch_id, 0))
            for b in batches
        ]
    )


@router.get("/{batch_id}", response_model=BatchDetail)
async def get_batch(request: Request, batch_id: str) -> BatchDetail:
    """A batch plus its full captures (404 if absent)."""
    store = _store(request)
    batch = store.get_batch(batch_id)
    if batch is None:
        raise _not_found(batch_id)
    captures = store.list_captures_by_batch(batch_id)
    return BatchDetail(
        **batch.model_dump(), episode_count=len(captures), captures=captures
    )


def _not_found(batch_id: str) -> ApiError:
    return ApiError(
        status_code=404,
        code="batch_not_found",
        message=f"Batch not found: {batch_id}",
        details={"batch_id": batch_id},
    )
