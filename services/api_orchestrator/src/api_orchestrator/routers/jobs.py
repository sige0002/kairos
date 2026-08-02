"""Pipeline job endpoints (``/api/v1/jobs``).

Keyed by ``capture_id`` (§10.5): a job resolves its source as
``objects/<capture_id>`` — there is no ``dataset_dir`` parameter any more — and
writes to ``report/<pipeline>/<capture_id>/``.
"""

from __future__ import annotations

from pathlib import PurePosixPath

from fastapi import APIRouter, Request, status
from kairos_common import ApiError, JobState

from api_orchestrator.events import EVENT_JOB
from api_orchestrator.models import (
    UNFINALIZED_STATES,
    JobCreateRequest,
    JobCreateResponse,
    JobResult,
    JobStatus,
)

router = APIRouter(prefix="/api/v1/jobs", tags=["jobs"])

# Capture states for which an export must be refused: the bag is still being
# written, so exporting it would read a recording mid-flight.
_UNFINISHED_STATES = UNFINALIZED_STATES

# Pipelines whose `template` param is a Config-catalog template id: the id is
# resolved to the full object before forwarding (dora_runner's template store is
# empty at boot). fast_validation matches the template's topics directly;
# full_validation hands them to its flow as ${KAIROS_REQUIRED_TOPICS}, so the
# Config tab's active template drives both.
_TEMPLATE_PIPELINES = {"fast_validation", "full_validation"}


async def _emit_job(request: Request, job: JobStatus | JobCreateResponse) -> None:
    await request.app.state.event_hub.publish(
        EVENT_JOB,
        {
            "job_id": job.job_id,
            "capture_id": job.capture_id,
            "pipeline": job.pipeline,
            "state": job.state.value,
            "progress": job.progress,
        },
    )


def _job_event_changed(
    previous: JobStatus | None, job: JobStatus | JobCreateResponse
) -> bool:
    """Whether *job* differs from *previous* in the fields an SSE ``job`` event carries.

    ``GET /{job_id}/status`` is polled, so it must not re-broadcast an identical
    event on every poll. The emitted payload only carries ``state``/``progress``
    (job_id/capture_id/pipeline are fixed per job), so those are the only fields
    that can change what a subscriber sees. A first sighting (``previous is None``)
    always counts as a change.
    """
    if previous is None:
        return True
    return (previous.state, previous.progress) != (job.state, job.progress)


@router.post("", response_model=JobCreateResponse, status_code=status.HTTP_201_CREATED)
async def create_job(request: Request, body: JobCreateRequest) -> JobCreateResponse:
    """Create a dora_runner job and persist its initial status.

    For a template-driven job, resolve the ``template`` param into the FULL
    template object before forwarding. The UI sends a template *id* (file stem,
    e.g. ``airoa_hsr``), but dora_runner's template store starts empty, so a bare
    id always 404s — we look the id up in the Config catalog and inject the
    object. A missing/blank id falls back to the active selection; a param that
    is already a full object (dict) is passed through untouched.
    """
    client = request.app.state.dora_runner_client
    store = request.app.state.capture_store
    payload = body.model_dump()
    capture = store.get_capture(body.capture_id)
    if capture is None:
        raise ApiError(
            status_code=404,
            code="capture_not_found",
            message=f"Capture not found: {body.capture_id}",
            details={"capture_id": body.capture_id},
        )
    if str(capture.state) in _UNFINISHED_STATES:
        raise ApiError(
            status_code=409,
            code="capture_not_finished",
            message="Cannot run a job on a capture that is still recording.",
            details={"capture_id": body.capture_id, "state": str(capture.state)},
        )
    if body.pipeline in _TEMPLATE_PIPELINES:
        raw = body.params.get("template")
        if not isinstance(raw, dict):
            catalog = request.app.state.config_catalog
            template = None
            if isinstance(raw, str) and raw:
                template = catalog.validation_template_by_id(raw)
            if template is None:  # blank id, or id not in the catalog
                template = catalog.active_validation_template()
            if template is not None:
                payload["params"] = {**body.params, "template": template.model_dump()}
    created = await client.create_job(payload)
    status_body = await client.job_status(str(created["job_id"]))
    job = JobCreateResponse.model_validate(status_body)
    store.upsert_job(job)
    await _emit_job(request, job)
    return job


@router.get("/{job_id}/status", response_model=JobStatus)
async def job_status(request: Request, job_id: str) -> JobStatus:
    """Return current job status.

    Emits a ``job`` SSE event ONLY when the state/progress actually changed
    versus the stored row, so polling this endpoint does not flood subscribers
    with duplicate events. The upsert itself is idempotent and always runs.
    """
    body = await request.app.state.dora_runner_client.job_status(job_id)
    job = JobStatus.model_validate(body)
    store = request.app.state.capture_store
    previous = store.get_job(job_id)
    store.upsert_job(job)
    if _job_event_changed(previous, job):
        await _emit_job(request, job)
    return job


def _data_relative_artifacts(artifacts: list[str], data_dir: str) -> list[str]:
    """Strip the data root from artifact paths so they are fetchable.

    ``GET /api/v1/files/{path}`` resolves its path INSIDE the data dir, so an
    artifact must be reported without that prefix — that is what lets the UI
    render a plugin's image artifacts inline with zero UI edits (the dora-only
    visualisation channel).

    dora_runner reports artifacts prefixed with its own ``data_dir``, which is
    ``./data`` by default and ``/data`` when a deployment sets an absolute one —
    so BOTH forms are stripped here (``data/report/x`` and ``/data/report/x``
    against a configured ``./data``). Matching only the absolute form left every
    artifact link 404ing on the default config. Paths under neither root pass
    through unchanged.
    """
    configured = PurePosixPath(data_dir)
    # Both spellings of the configured root: the services run with the image
    # root as cwd, so "./data" and "/data" name the same tree (compose mounts
    # ${DATA_DIR} at /data), and the two sides may report either one.
    twin = (
        PurePosixPath("/") / configured
        if not configured.is_absolute()
        else PurePosixPath(*configured.parts[1:])
    )
    roots = {configured, twin}
    out: list[str] = []
    for artifact in artifacts:
        path = PurePosixPath(artifact)
        for root in roots:
            try:
                out.append(str(path.relative_to(root)))
                break
            except ValueError:
                continue
        else:  # under no known root: leave it exactly as reported
            out.append(artifact)
    return out


@router.get("/{job_id}/result", response_model=JobResult)
async def job_result(request: Request, job_id: str) -> JobResult:
    """Return a terminal job result (artifacts normalised to data-relative)."""
    body = await request.app.state.dora_runner_client.job_result(job_id)
    result = JobResult.model_validate(body)
    result.artifacts = _data_relative_artifacts(
        result.artifacts, request.app.state.settings.data_dir
    )
    status_body = await request.app.state.dora_runner_client.job_status(job_id)
    job = JobStatus.model_validate(status_body)
    if job.state not in {JobState.succeeded, JobState.failed, JobState.canceled}:
        raise ApiError(
            status_code=409,
            code="job_not_terminal",
            message=(
                "Job result is only available after the job reaches a terminal state."
            ),
        )
    request.app.state.capture_store.upsert_job(job, result=result)
    return result


@router.post("/{job_id}/cancel", response_model=JobStatus)
async def cancel_job(request: Request, job_id: str) -> JobStatus:
    """Cancel a running or queued job."""
    body = await request.app.state.dora_runner_client.cancel_job(job_id)
    job = JobStatus.model_validate(body)
    request.app.state.capture_store.upsert_job(job)
    await _emit_job(request, job)
    return job
