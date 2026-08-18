# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Public durable Validation Run endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Query, Request, status
from kairos_common import ApiError

from api_orchestrator.validation_models import (
    ValidationRun,
    ValidationRunCreateRequest,
    ValidationRunListResponse,
)

router = APIRouter(prefix="/api/v1/validation/runs", tags=["validation"])


def _store(request: Request):  # noqa: ANN201 - FastAPI state is untyped
    return request.app.state.validation_run_store


@router.post("", response_model=ValidationRun, status_code=status.HTTP_202_ACCEPTED)
def create_run(request: Request, body: ValidationRunCreateRequest) -> ValidationRun:
    """Persist run intent before the supervisor contacts dora_runner."""
    if body.selection_id is not None:
        try:
            recovered = _store(request).recover_selection_request(
                str(body.request_id), body.pipeline, body.params, body.selection_id
            )
        except ValueError as exc:
            raise ApiError(
                status_code=409,
                code="validation_run_idempotency_conflict",
                message="request_id was already used for a different validation run.",
                details={"request_id": str(body.request_id)},
            ) from exc
        if recovered is not None:
            request.app.state.validation_supervisor.acquire_local_leases(
                recovered.run_id
            )
            return recovered
        try:
            capture_ids = request.app.state.capture_service.selection_capture_ids(
                body.selection_id
            )
        except KeyError as exc:
            raise ApiError(
                status_code=409,
                code="capture_selection_expired",
                message=(
                    "The capture selection is missing or has expired; create it again."
                ),
                details={"selection_id": body.selection_id},
            ) from exc
        if not capture_ids:
            raise ApiError(
                status_code=409,
                code="no_validation_targets",
                message="The capture selection contains no validation targets.",
                details={"selection_id": body.selection_id},
            )
        if len(capture_ids) > 1000:
            raise ApiError(
                status_code=409,
                code="validation_run_too_large",
                message=(
                    "The resolved capture selection exceeds this Validation Run's "
                    "1,000-item limit; narrow the filters and try again."
                ),
                details={"matched_count": len(capture_ids), "max": 1000},
            )
    else:
        capture_ids = body.capture_ids
        assert capture_ids is not None
    try:
        run = _store(request).create_run(
            body.pipeline,
            capture_ids,
            body.params,
            str(body.request_id),
            body.selection_id,
        )
        # Intent is durable before this point. This local-only renewal closes
        # the queued-before-first-supervisor-tick delete race without making
        # the HTTP response wait for preflight or dora_runner.
        request.app.state.validation_supervisor.acquire_local_leases(run.run_id)
        return run
    except ValueError as exc:
        raise ApiError(
            status_code=409,
            code="validation_run_idempotency_conflict",
            message="request_id was already used for a different validation run.",
            details={"request_id": body.request_id},
        ) from exc


@router.get("", response_model=ValidationRunListResponse)
def list_runs(
    request: Request,
    active: bool = Query(True),
    limit: int = Query(20, ge=1, le=100),
) -> ValidationRunListResponse:
    return ValidationRunListResponse(
        items=_store(request).list_runs(active=active, limit=limit)
    )


@router.get("/{run_id}", response_model=ValidationRun)
def get_run(request: Request, run_id: str) -> ValidationRun:
    run = _store(request).get_run(run_id)
    if run is None:
        raise _not_found(run_id)
    return run


@router.post(
    "/{run_id}/cancel",
    response_model=ValidationRun,
    status_code=status.HTTP_202_ACCEPTED,
)
def cancel_run(request: Request, run_id: str) -> ValidationRun:
    try:
        return _store(request).request_cancel(run_id)
    except KeyError as exc:
        raise _not_found(run_id) from exc


@router.post(
    "/{run_id}/retry-failed",
    response_model=ValidationRun,
    status_code=status.HTTP_202_ACCEPTED,
)
def retry_failed(request: Request, run_id: str) -> ValidationRun:
    try:
        run = _store(request).retry_failed(run_id)
        request.app.state.validation_supervisor.acquire_local_leases(run.run_id)
        return run
    except KeyError as exc:
        raise _not_found(run_id) from exc
    except ValueError as exc:
        raise ApiError(
            status_code=409,
            code="validation_run_not_retryable",
            message="Wait for this validation run to finish before retrying failures.",
            details={"run_id": run_id},
        ) from exc


def _not_found(run_id: str) -> ApiError:
    return ApiError(
        status_code=404,
        code="validation_run_not_found",
        message=f"Validation run not found: {run_id}",
        details={"run_id": run_id},
    )
