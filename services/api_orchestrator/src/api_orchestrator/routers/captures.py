"""Capture endpoints (``/api/v1/captures``) — the v2 replacement for runs.

Contract §10. One resource now covers what ``/runs`` and ``/episodes`` used to
split between them: a capture carries the recording facts and the operator's
review, so listing, reviewing, deleting and archiving are all addressed by
``capture_id``. Both old routers are retired with no compatibility alias.

Two response codes here are load-bearing rather than incidental:

* ``409 review_conflict`` from ``PATCH .../review`` means someone else saved
  first. The client reloads and re-applies; it never merges (§4.1).
* ``409 capture_busy`` from ``POST .../delete`` means a job holds the capture's
  lease (§7.1). Deleting under a running digest would pull the directory out
  from beneath it.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, Query, Request
from kairos_common import ApiError, archive_enabled, parse_archive_roots
from kairos_common.archive_paths import resolve_archive_destination

from api_orchestrator.captures import CaptureService
from api_orchestrator.deps import get_capture_service
from api_orchestrator.models import (
    Capture,
    CaptureArchiveRequest,
    CaptureArchiveResponse,
    CaptureDeleteRequest,
    CaptureDetail,
    CaptureListResponse,
    ReviewSaveRequest,
)

router = APIRouter(prefix="/api/v1/captures", tags=["captures"])

DEFAULT_LIMIT = 50
MAX_LIMIT = 200


@router.get("", response_model=CaptureListResponse)
async def list_captures(
    service: CaptureService = Depends(get_capture_service),
    limit: int = Query(DEFAULT_LIMIT, ge=1, le=MAX_LIMIT),
    cursor: str | None = Query(None),
    state: str | None = Query(None),
    review_status: str | None = Query(None),
    task: str | None = Query(None),
    operator: str | None = Query(None),
    robot: str | None = Query(None),
    batch: str | None = Query(None),
    include_deleted: bool = Query(False),
) -> CaptureListResponse:
    """List captures newest-first, with the local replica state and digest_state.

    Tombstoned captures are excluded by default: the row survives a deletion so
    "where did it go" stays answerable (§7), but the default list is the
    operator's working set, not the archive of everything that ever existed.

    Two ways to see them. ``include_deleted=true`` widens the default list to
    include tombstones, and an explicit ``state=discarded`` (or ``deleted``)
    returns exactly those — a state filter the caller named is always honoured
    as asked, because silently returning nothing for a state that plainly
    exists would be the more confusing answer.
    """
    items, next_cursor = service.list(
        limit,
        cursor,
        state=state,
        review_status=review_status,
        task=task,
        operator=operator,
        robot=robot,
        batch_id=batch,
        include_deleted=include_deleted,
    )
    return CaptureListResponse(items=items, next_cursor=next_cursor)


@router.get("/{capture_id}", response_model=CaptureDetail)
async def get_capture(
    capture_id: str,
    service: CaptureService = Depends(get_capture_service),
) -> CaptureDetail:
    """One capture with its sidecars and pipeline reports (404 if unknown)."""
    return service.get_detail(capture_id)


@router.patch("/{capture_id}/review", response_model=Capture)
async def save_review(
    capture_id: str,
    body: ReviewSaveRequest,
    service: CaptureService = Depends(get_capture_service),
) -> Capture:
    """Save a review: ``record.json`` first, then a compare-and-swap (§4.1).

    ``base_revision`` must equal the capture's current ``review_revision`` or
    the save is refused with ``409``. A ``500`` means the sidecar could not be
    written and **nothing** was saved — the request is safe to retry with the
    same ``base_revision``.
    """
    return await service.save_review(capture_id, body)


@router.post("/{capture_id}/delete", response_model=Capture)
async def delete_capture(
    capture_id: str,
    body: CaptureDeleteRequest,
    background: BackgroundTasks,
    service: CaptureService = Depends(get_capture_service),
) -> Capture:
    """Discard or delete a capture (§7). The row survives as a tombstone.

    The response returns as soon as the capture is in ``.trash`` and the
    tombstone is committed; the physical removal (the reaper) runs afterwards.
    That split is the point: the operator's action is durable at the tombstone,
    and a reaper that fails leaves a visible ``trashed`` replica rather than a
    request that hung on an unlink.
    """
    if body.kind == "discard" and not (body.reason or "").strip():
        raise ApiError(
            status_code=400,
            code="reason_required",
            message=(
                "A discard is irreversible and the ledger line is the only "
                "surviving explanation of why the data is gone. Give a reason."
            ),
            details={"capture_id": capture_id},
        )
    capture = await service.delete(capture_id, kind=body.kind, reason=body.reason)
    background.add_task(service.reap, capture_id)
    return capture


@router.get("/{capture_id}/archive/config")
async def capture_archive_config(request: Request) -> dict[str, Any]:
    """Where this deployment may archive to.

    The UI asks before showing any archive control: with no configured roots the
    feature is not offered at all, rather than presented as a button that can
    only ever fail.
    """
    roots = _archive_roots(request)
    return {"enabled": archive_enabled(roots), "roots": [str(r) for r in roots]}


@router.post("/{capture_id}/archive", response_model=CaptureArchiveResponse)
async def archive_capture(
    capture_id: str,
    body: CaptureArchiveRequest,
    request: Request,
    background: BackgroundTasks,
    service: CaptureService = Depends(get_capture_service),
) -> CaptureArchiveResponse:
    """Copy a capture out, verify it, record it, then delete the source (§6).

    The destination is validated against ``KAIROS_ARCHIVE_ROOTS`` before
    anything is copied: this endpoint deletes the source afterwards, which makes
    an unconstrained destination the most dangerous string in the system.
    """
    destination = resolve_archive_destination(body.destination, _archive_roots(request))
    result = await service.archive(
        capture_id,
        destination=destination,
        operator=body.operator,
        reason=body.reason,
    )
    background.add_task(service.reap, capture_id)
    return result


def _archive_roots(request: Request) -> list:
    return parse_archive_roots(getattr(request.app.state.settings, "archive_roots", ""))
