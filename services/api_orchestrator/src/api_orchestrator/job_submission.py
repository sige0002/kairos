# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Shared preflight and template resolution for every dora job submission."""

from __future__ import annotations

from fastapi import Request
from kairos_common import ApiError

from api_orchestrator.models import (
    UNFINALIZED_STATES,
    Capture,
    CaptureState,
    JobCreateRequest,
)
from api_orchestrator.store import PRESENT_REPLICA_STATES, CaptureStore

_TEMPLATE_PIPELINES = {"fast_validation", "full_validation"}


def prepare_job_submission(request: Request, body: JobCreateRequest) -> dict:
    """Validate a local finished capture and resolve a template id once."""
    return prepare_job_submission_for(
        request.app.state.capture_store,
        request.app.state.instance_id,
        request.app.state.config_catalog,
        body,
    )


def prepare_job_submission_for(
    store: CaptureStore,
    instance_id: str,
    catalog,
    body: JobCreateRequest,  # noqa: ANN001
) -> dict:
    """The same preflight for background outbox dispatch without a Request."""
    capture = store.get_capture(body.capture_id)
    if capture is None:
        raise ApiError(
            status_code=404,
            code="capture_not_found",
            message=f"Capture not found: {body.capture_id}",
            details={"capture_id": body.capture_id},
        )
    if str(capture.state) in UNFINALIZED_STATES:
        raise ApiError(
            status_code=409,
            code="capture_not_finished",
            message="Cannot run a job on a capture that is still recording.",
            details={"capture_id": body.capture_id, "state": str(capture.state)},
        )
    _reject_tombstoned(capture)
    _reject_not_local(store, instance_id, capture)
    # Keep the pre-existing runner payload for ordinary jobs. The additive
    # idempotency field is forwarded only when a durable caller supplies it.
    payload = body.model_dump(exclude_none=True)
    if body.pipeline in _TEMPLATE_PIPELINES and not isinstance(
        body.params.get("template"), dict
    ):
        raw = body.params.get("template")
        template = (
            catalog.validation_template_by_id(raw)
            if isinstance(raw, str) and raw
            else None
        )
        template = template or catalog.active_validation_template()
        if template is not None:
            payload["params"] = {**body.params, "template": template.model_dump()}
    return payload


def _reject_tombstoned(capture: Capture) -> None:
    if capture.state not in (
        CaptureState.delete_pending,
        CaptureState.discarded,
        CaptureState.deleted,
    ):
        return
    pending = capture.state == CaptureState.delete_pending
    kind = capture.delete_kind or ("delete" if pending else "deleted")
    raise ApiError(
        status_code=409,
        code="capture_deleting" if pending else "capture_deleted",
        message=(
            f"{capture.capture_id} is being {kind}d; no new job can be run against it."
            if pending
            else (
                f"{capture.capture_id} was {kind}"
                f"{' on ' + capture.deleted_at if capture.deleted_at else ''}; "
                "no job can be run against it."
            )
        ),
        details={"capture_id": capture.capture_id, "state": str(capture.state)},
    )


def _reject_not_local(store: CaptureStore, instance_id: str, capture: Capture) -> None:
    replica = store.get_replica(capture.capture_id, instance_id)
    if replica is None or str(replica.state) in PRESENT_REPLICA_STATES:
        return
    raise ApiError(
        status_code=409,
        code="capture_not_local",
        message=(
            f"{capture.capture_id} has no local copy on this installation "
            f"(replica state: {replica.state}); transfer or restore it before "
            "running a job."
        ),
        details={
            "capture_id": capture.capture_id,
            "replica_state": str(replica.state),
        },
    )
