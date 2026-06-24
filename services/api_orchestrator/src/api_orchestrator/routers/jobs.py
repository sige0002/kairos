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
)

router = APIRouter(prefix="/api/v1/jobs", tags=["jobs"])


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


@router.post("", response_model=JobCreateResponse, status_code=status.HTTP_201_CREATED)
async def create_job(request: Request, body: JobCreateRequest) -> JobCreateResponse:
    """Create a dora_runner job and persist its initial status.

    For a ``fast_validation`` job with no explicit ``template`` param, inject the
    Config tab's active validation template so the operator's selection applies
    immediately (no restart).
    """
    client = request.app.state.dora_runner_client
    store = request.app.state.run_store
    payload = body.model_dump()
    if body.pipeline == "fast_validation" and not body.params.get("template"):
        active = request.app.state.config_catalog.active_validation_template()
        if active is not None:
            payload["params"] = {**body.params, "template": active.model_dump()}
    created = await client.create_job(payload)
    status_body = await client.job_status(str(created["job_id"]))
    job = JobCreateResponse.model_validate(status_body)
    store.upsert_job(job)
    await _emit_job(request, job)
    return job


@router.get("/{job_id}/status", response_model=JobStatus)
async def job_status(request: Request, job_id: str) -> JobStatus:
    """Return current job status."""
    body = await request.app.state.dora_runner_client.job_status(job_id)
    job = JobStatus.model_validate(body)
    request.app.state.run_store.upsert_job(job)
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
