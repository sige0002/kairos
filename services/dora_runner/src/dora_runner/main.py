"""dora_runner service."""

from __future__ import annotations

import asyncio
import uuid
from pathlib import Path

from fastapi import FastAPI, Query, status
from fastapi.routing import APIRoute
from kairos_common import ApiError, JobState, Settings, create_app, get_settings

from dora_runner.models import (
    JobCreateRequest,
    JobCreateResponse,
    JobResult,
    JobStatus,
    PipelineDefinition,
    TemplateGenerateRequest,
    ValidationTemplate,
    ValidationTemplateListResponse,
)
from dora_runner.pipelines import PIPELINES
from dora_runner.store import JobRecord, RunnerStore
from dora_runner.validation import generate_template, run_fast_validation

SERVICE_NAME = "dora_runner"


def _override_readyz(app: FastAPI) -> None:
    """Report dora_runner readiness."""
    app.router.routes = [
        route
        for route in app.router.routes
        if not (isinstance(route, APIRoute) and route.path == "/readyz")
    ]

    @app.get("/readyz", tags=["health"])
    async def readyz() -> dict[str, object]:
        return {"status": "ready", "components": {"dora": "ok"}}


def create_dora_app(settings: Settings | None = None) -> FastAPI:
    """Build the dora_runner app."""
    settings = settings or get_settings()
    data_dir = Path(settings.data_dir)
    store = RunnerStore()
    app = create_app(SERVICE_NAME, settings=settings)
    app.state.runner_store = store
    app.state.data_dir = data_dir

    _override_readyz(app)

    @app.get("/")
    async def root() -> dict[str, str]:
        return {"service": SERVICE_NAME, "stage": "stage3"}

    @app.get("/pipelines", response_model=dict[str, list[PipelineDefinition]])
    async def pipelines() -> dict[str, list[PipelineDefinition]]:
        return {"items": PIPELINES}

    @app.post(
        "/jobs", response_model=JobCreateResponse, status_code=status.HTTP_201_CREATED
    )
    async def create_job(body: JobCreateRequest) -> JobCreateResponse:
        if body.pipeline != "fast_validation":
            raise ApiError(
                status_code=400,
                code="pipeline_unavailable",
                message=f"Pipeline is not implemented: {body.pipeline}",
            )
        job = JobRecord(
            job_id=f"job_{uuid.uuid4().hex}",
            run_id=body.run_id,
            pipeline=body.pipeline,
            params=body.params,
        )
        async with store.lock:
            store.jobs[job.job_id] = job
        job.task = asyncio.create_task(_execute_job(job, store, data_dir))
        return JobCreateResponse(job_id=job.job_id)

    @app.get("/jobs/{job_id}/status", response_model=JobStatus)
    async def job_status(job_id: str) -> JobStatus:
        return (await _get_job(store, job_id)).status()

    @app.get("/jobs/{job_id}/result", response_model=JobResult)
    async def job_result(job_id: str) -> JobResult:
        job = await _get_job(store, job_id)
        if job.state not in {JobState.succeeded, JobState.failed, JobState.canceled}:
            raise ApiError(
                status_code=409,
                code="job_not_terminal",
                message=(
                    "Job result is only available after the job reaches a terminal "
                    "state."
                ),
            )
        if job.result is None:
            raise ApiError(
                status_code=404,
                code="job_result_not_found",
                message=f"Job result not found: {job_id}",
            )
        return job.result

    @app.post("/jobs/{job_id}/cancel", response_model=JobStatus)
    async def cancel_job(job_id: str) -> JobStatus:
        job = await _get_job(store, job_id)
        if job.state in {JobState.queued, JobState.running}:
            job.state = JobState.canceled
            job.progress = min(job.progress, 1.0)
            job.logs_tail.append("Job canceled.")
            if job.task is not None:
                job.task.cancel()
        return job.status()

    @app.get("/validation/templates", response_model=ValidationTemplateListResponse)
    async def list_templates(
        limit: int = Query(default=50, ge=1, le=200),
        cursor: str | None = None,
    ) -> ValidationTemplateListResponse:
        parsed = _parse_cursor(cursor)
        items, next_cursor = await store.list_templates(limit, parsed)
        return ValidationTemplateListResponse(
            items=items,
            next_cursor=str(next_cursor) if next_cursor is not None else None,
        )

    @app.post(
        "/validation/templates",
        response_model=ValidationTemplate,
        status_code=status.HTTP_201_CREATED,
    )
    async def create_template(body: ValidationTemplate) -> ValidationTemplate:
        return await store.add_template(body)

    @app.post("/validation/templates/generate", response_model=ValidationTemplate)
    async def generate(body: TemplateGenerateRequest) -> ValidationTemplate:
        try:
            return generate_template(body.run_id, data_dir)
        except FileNotFoundError as exc:
            raise ApiError(
                status_code=404,
                code="run_mcap_not_found",
                message=str(exc),
                details={"run_id": body.run_id},
            ) from exc

    return app


async def _get_job(store: RunnerStore, job_id: str) -> JobRecord:
    """Return a job or raise a unified 404."""
    async with store.lock:
        job = store.jobs.get(job_id)
    if job is None:
        raise ApiError(
            status_code=404,
            code="job_not_found",
            message=f"Job not found: {job_id}",
            details={"job_id": job_id},
        )
    return job


def _parse_cursor(cursor: str | None) -> int | None:
    """Parse an opaque pagination cursor."""
    if cursor is None:
        return None
    try:
        return int(cursor)
    except ValueError as exc:
        raise ApiError(
            status_code=400,
            code="invalid_cursor",
            message="cursor must be an opaque token from a prior page.",
        ) from exc


async def _resolve_template(
    job: JobRecord, store: RunnerStore, data_dir: Path
) -> ValidationTemplate:
    """Resolve a fast_validation template from job params."""
    raw = job.params.get("template")
    if isinstance(raw, dict):
        return ValidationTemplate.model_validate(raw)
    if isinstance(raw, str):
        template = await store.get_template(raw)
        if template is not None:
            return template
        raise ApiError(
            status_code=400,
            code="template_not_found",
            message=f"Validation template not found: {raw}",
            details={"template": raw},
        )
    # If the caller omitted a template, use the run itself as a draft baseline.
    return generate_template(job.run_id, data_dir)


async def _execute_job(job: JobRecord, store: RunnerStore, data_dir: Path) -> None:
    """Run a queued job in the process-local async worker."""
    try:
        job.state = JobState.running
        job.progress = 0.1
        job.logs_tail.append("Job started.")
        template = await _resolve_template(job, store, data_dir)
        job.progress = 0.4
        result = await asyncio.to_thread(
            run_fast_validation,
            run_id=job.run_id,
            data_dir=data_dir,
            template=template,
        )
        job.result = JobResult.model_validate(result)
        job.progress = 1.0
        job.state = JobState.succeeded
        job.logs_tail.append("Job succeeded.")
    except asyncio.CancelledError:
        job.state = JobState.canceled
        job.logs_tail.append("Job canceled.")
    except ApiError as exc:
        job.state = JobState.failed
        job.progress = 1.0
        job.logs_tail.append(exc.message)
        job.result = JobResult(
            summary={"result": "fail", "error": exc.to_model().model_dump()},
            artifacts=[],
        )
    except Exception as exc:  # noqa: BLE001 - job failures are status, not 500s.
        job.state = JobState.failed
        job.progress = 1.0
        job.logs_tail.append(str(exc))
        job.result = JobResult(
            summary={
                "result": "fail",
                "error": {"code": "job_failed", "message": str(exc)},
            },
            artifacts=[],
        )


app = create_dora_app()


def main() -> None:
    """Run the service with uvicorn, binding host/port from config."""
    import uvicorn

    settings = get_settings()
    uvicorn.run(app, host=settings.bind_host, port=settings.dora_runner_port)


if __name__ == "__main__":
    main()
