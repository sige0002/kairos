"""Pipeline job endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Request, status
from kairos_common import ApiError, JobState

from api_orchestrator.events import EVENT_JOB
from api_orchestrator.models import (
    JobCreateRequest,
    JobCreateResponse,
    JobResult,
    JobStatus,
    RunState,
)

router = APIRouter(prefix="/api/v1/jobs", tags=["jobs"])

# Run states for which a dataset_export must be refused (the bag is still being
# written; exporting it would copy a partial/active recording).
_UNFINISHED_STATES = {RunState.created, RunState.recording, RunState.stopping}


async def _emit_job(request: Request, job: JobStatus | JobCreateResponse) -> None:
    await request.app.state.event_hub.publish(
        EVENT_JOB,
        {
            "job_id": job.job_id,
            "run_id": job.run_id,
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
    (job_id/run_id/pipeline are fixed per job), so those are the only fields that
    can change what a subscriber sees. A first sighting (``previous is None``)
    always counts as a change.
    """
    if previous is None:
        return True
    return (previous.state, previous.progress) != (job.state, job.progress)


@router.post("", response_model=JobCreateResponse, status_code=status.HTTP_201_CREATED)
async def create_job(request: Request, body: JobCreateRequest) -> JobCreateResponse:
    """Create a dora_runner job and persist its initial status.

    For a ``fast_validation`` job, resolve the ``template`` param into the FULL
    template object before forwarding. The UI sends a template *id* (file stem,
    e.g. ``airoa_hsr``), but dora_runner's template store starts empty, so a bare
    id always 404s — we look the id up in the Config catalog and inject the
    object. A missing/blank id falls back to the active selection; a param that
    is already a full object (dict) is passed through untouched.
    """
    client = request.app.state.dora_runner_client
    store = request.app.state.run_store
    payload = body.model_dump()
    if body.pipeline == "dataset_export":
        # Only export a finished recording; never copy a bag mid-write.
        run = store.get(body.run_id)
        if run is None:
            raise ApiError(
                status_code=404,
                code="run_not_found",
                message=f"Run not found: {body.run_id}",
                details={"run_id": body.run_id},
            )
        if run.state in _UNFINISHED_STATES:
            raise ApiError(
                status_code=409,
                code="run_not_finished",
                message="Cannot export a run that has not finished recording.",
                details={"run_id": body.run_id, "state": run.state.value},
            )
    if body.pipeline == "fast_validation":
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
    store = request.app.state.run_store
    previous = store.get_job(job_id)
    store.upsert_job(job)
    if _job_event_changed(previous, job):
        await _emit_job(request, job)
    return job


@router.get("/{job_id}/result", response_model=JobResult)
async def job_result(request: Request, job_id: str) -> JobResult:
    """Return a terminal job result."""
    body = await request.app.state.dora_runner_client.job_result(job_id)
    result = JobResult.model_validate(body)
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
    request.app.state.run_store.upsert_job(job, result=result)
    return result


@router.post("/{job_id}/cancel", response_model=JobStatus)
async def cancel_job(request: Request, job_id: str) -> JobStatus:
    """Cancel a running or queued job."""
    body = await request.app.state.dora_runner_client.cancel_job(job_id)
    job = JobStatus.model_validate(body)
    request.app.state.run_store.upsert_job(job)
    await _emit_job(request, job)
    return job
