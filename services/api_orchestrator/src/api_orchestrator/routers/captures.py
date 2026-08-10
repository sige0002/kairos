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

import asyncio
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, Query, Request
from kairos_common import ApiError, archive_enabled, parse_archive_roots
from kairos_common.archive_paths import resolve_archive_destination

from api_orchestrator.capture_archive import CaptureArchiveRun, CaptureArchiveRuns
from api_orchestrator.captures import CaptureService
from api_orchestrator.deps import get_capture_service
from api_orchestrator.models import (
    Capture,
    CaptureArchiveAccepted,
    CaptureArchiveProgress,
    CaptureArchiveRequest,
    CaptureArchiveResponse,
    CaptureDeleteRequest,
    CaptureDetail,
    CaptureListResponse,
    ReviewSaveRequest,
    ValidationOverrideRequest,
)

router = APIRouter(prefix="/api/v1/captures", tags=["captures"])

DEFAULT_LIMIT = 50
# 1000, not 200: Datasets walks the whole store to build its tree, and at 200 a
# 5,000-capture store cost 26 sequential round trips (E-27). The DEFAULT stays
# 50 — a page an operator waits for should not become a 5,000-row response —
# so this only widens what a client deliberately asking for everything may ask.
MAX_LIMIT = 1000


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


@router.post("/{capture_id}/validation-override", response_model=Capture)
async def override_validation(
    capture_id: str,
    body: ValidationOverrideRequest,
    service: CaptureService = Depends(get_capture_service),
) -> Capture:
    """Let a failed-validation capture into datasets anyway, on the record.

    A reason is mandatory for the same purpose as a discard's: the gate is
    there because a validator found something, and overriding it silently
    would leave the dataset containing data nobody can account for. Send
    ``reason: null`` to withdraw a previous override.
    """
    reason = (body.reason or "").strip() or None
    if reason is None and body.reason is not None:
        raise ApiError(
            status_code=400,
            code="reason_required",
            message=(
                "An override is a judgement that outranks the validator — the "
                "ledger line is its only explanation. Give a reason."
            ),
            details={"capture_id": capture_id},
        )
    return service.set_validation_override(capture_id, reason)


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


@router.post(
    "/{capture_id}/archive", response_model=CaptureArchiveAccepted, status_code=202
)
async def archive_capture(
    capture_id: str,
    body: CaptureArchiveRequest,
    request: Request,
    service: CaptureService = Depends(get_capture_service),
) -> CaptureArchiveAccepted:
    """Start archiving a capture out (§6): copy, verify, record, then delete.

    The destination is validated against ``KAIROS_ARCHIVE_ROOTS`` before
    anything is copied: this endpoint deletes the source afterwards, which makes
    an unconstrained destination the most dangerous string in the system.

    Answers 202 and runs server-side (S2-1): a multi-GB copy outlives any proxy
    timeout, and completing it in-request produced the worst possible split —
    the server finished the archive (and deleted the source) while the client
    saw a 504 "failure". Poll ``GET /captures/{id}/archive`` for the outcome.
    The obvious refusals (active capture, held lease, dataset member, bad or
    overlapping destination) still answer synchronously.
    """
    destination = resolve_archive_destination(body.destination, _archive_roots(request))
    capture = service.archive_preflight(capture_id, destination=destination)
    runs: CaptureArchiveRuns = request.app.state.capture_archive_runs

    async def execute(run: CaptureArchiveRun) -> CaptureArchiveResponse:
        def on_progress(bytes_done: int) -> None:
            run.bytes_done = bytes_done

        result = await service.archive(
            capture_id,
            destination=destination,
            operator=body.operator,
            reason=body.reason,
            progress=on_progress,
        )
        await asyncio.to_thread(service.reap, capture_id)
        return result

    run = runs.start(capture_id, str(destination / capture_id), capture.bytes, execute)
    return CaptureArchiveAccepted(
        capture_id=capture_id, destination=run.destination, state=run.state
    )


@router.get("/{capture_id}/archive", response_model=CaptureArchiveProgress)
async def capture_archive_progress(
    capture_id: str, request: Request
) -> CaptureArchiveProgress:
    """Progress of this capture's archive run (running → complete | failed).

    404 when no run is known — including after a restart, which loses the
    in-memory progress view but neither the data nor the ledger record.
    """
    run = request.app.state.capture_archive_runs.get(capture_id)
    if run is None:
        raise ApiError(
            status_code=404,
            code="archive_not_found",
            message=f"No archive run is known for {capture_id}.",
            details={"capture_id": capture_id},
        )
    return run.progress()


def _archive_roots(request: Request) -> list:
    return parse_archive_roots(getattr(request.app.state.settings, "archive_roots", ""))
