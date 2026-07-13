"""dora_runner service."""

from __future__ import annotations

import asyncio
import logging
import os
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
from dora_runner.plugin_loader import dora_cli_available, effective_executor
from dora_runner.registry import DEFAULT_REGISTRY, RegisteredPipeline
from dora_runner.store import JobRecord, RunnerStore
from dora_runner.validation import generate_template

SERVICE_NAME = "dora_runner"

logger = logging.getLogger("kairos")

# Per-job execution limits (spec §: bounded concurrency + a per-job timeout).
# Read from the environment so a deployment can tune them; both fall back to
# safe defaults on an unset/garbage value. dora-specific knobs follow the in-tree
# KAIROS_* env convention (see plugin_loader's KAIROS_PLUGINS_DIR / _INPROCESS).
_MAX_CONCURRENCY_ENV = "KAIROS_DORA_MAX_CONCURRENCY"
_JOB_TIMEOUT_ENV = "KAIROS_DORA_JOB_TIMEOUT_S"
_DEFAULT_MAX_CONCURRENCY = 2
_DEFAULT_JOB_TIMEOUT_S = 900.0


def _job_max_concurrency() -> int:
    """Max jobs executed at once (``KAIROS_DORA_MAX_CONCURRENCY``, default 2)."""
    try:
        return max(1, int(os.environ.get(_MAX_CONCURRENCY_ENV, "")))
    except ValueError:
        return _DEFAULT_MAX_CONCURRENCY


def _job_timeout_s() -> float:
    """Per-job wall-clock budget (``KAIROS_DORA_JOB_TIMEOUT_S``, default 900s)."""
    try:
        return max(1.0, float(os.environ.get(_JOB_TIMEOUT_ENV, "")))
    except ValueError:
        return _DEFAULT_JOB_TIMEOUT_S


def _to_definition(pipeline: RegisteredPipeline) -> PipelineDefinition:
    """Project a registered pipeline to its public ``/pipelines`` metadata.

    ``effective_executor`` reflects how the pipeline ACTUALLY runs here: a
    ``dora``-declared pipeline degrades to ``in-process`` when the dora CLI is
    absent, so the API is honest about dora not being bundled (DORA-M2).
    """
    return PipelineDefinition(
        id=pipeline.id,
        name=pipeline.name,
        description=pipeline.description,
        enabled=pipeline.enabled,
        schema=pipeline.params_schema,
        required_inputs=pipeline.required_inputs,
        outputs=pipeline.outputs,
        executor=pipeline.executor,
        effective_executor=effective_executor(pipeline.executor),
    )


def _override_readyz(app: FastAPI) -> None:
    """Report dora_runner readiness, honest about dora availability (DORA-M2).

    The service is READY without the dora CLI — dataflows fall back to the
    in-process interpreter — so ``status`` stays ``ready``; the ``dora``
    component reports the real executor mode (``available`` vs ``in-process``)
    instead of a fixed ``ok`` that implied dora was bundled.
    """
    app.router.routes = [
        route
        for route in app.router.routes
        if not (isinstance(route, APIRoute) and route.path == "/readyz")
    ]

    @app.get("/readyz", tags=["health"])
    async def readyz() -> dict[str, object]:
        dora = "available" if dora_cli_available() else "in-process"
        return {"status": "ready", "components": {"dora": dora}}


def create_dora_app(
    settings: Settings | None = None, *, store: RunnerStore | None = None
) -> FastAPI:
    """Build the dora_runner app.

    The job/template store is SQLite-backed at ``<data_dir>/dora_runner.db`` (beside
    the ``report/`` tree), so state survives a restart. Pass *store* to inject one
    (tests use ``RunnerStore(":memory:")``). On startup any job the previous process
    left in flight is reconciled to a terminal ``failed``/interrupted state.
    """
    settings = settings or get_settings()
    data_dir = Path(settings.data_dir)
    store = store or RunnerStore(str(data_dir / "dora_runner.db"))
    interrupted = store.reconcile_interrupted_jobs()
    if interrupted:
        logger.info(
            "reconciled interrupted dora jobs at start", extra={"count": interrupted}
        )
    app = create_app(SERVICE_NAME, settings=settings)
    app.state.runner_store = store
    app.state.data_dir = data_dir
    # Bound how many jobs execute at once, and cap each job's wall-clock budget
    # (DORA-M1). The semaphore is per-app (bound to this app's event loop) so
    # concurrent TestClients don't share a cross-loop primitive.
    job_slots = asyncio.Semaphore(_job_max_concurrency())
    job_timeout_s = _job_timeout_s()

    _override_readyz(app)

    @app.get("/")
    async def root() -> dict[str, str]:
        return {"service": SERVICE_NAME, "stage": "stage3"}

    @app.get("/pipelines", response_model=dict[str, list[PipelineDefinition]])
    async def pipelines() -> dict[str, list[PipelineDefinition]]:
        return {"items": [_to_definition(p) for p in DEFAULT_REGISTRY.all()]}

    @app.post(
        "/jobs", response_model=JobCreateResponse, status_code=status.HTTP_201_CREATED
    )
    async def create_job(body: JobCreateRequest) -> JobCreateResponse:
        if not DEFAULT_REGISTRY.runnable(body.pipeline):
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
            store.persist_job(job)
        job.task = asyncio.create_task(
            _execute_job(job, store, data_dir, slots=job_slots, timeout_s=job_timeout_s)
        )
        return JobCreateResponse(job_id=job.job_id)

    @app.get("/jobs/{job_id}/status", response_model=JobStatus)
    async def job_status(job_id: str) -> JobStatus:
        async with store.lock:
            live = store.jobs.get(job_id)
        # Prefer the live worker's view; fall back to the persisted row for a job
        # with no in-process handle (e.g. one reconciled to failed at startup).
        if live is not None:
            return live.status()
        persisted = store.get_persisted_job(job_id)
        if persisted is None:
            raise _job_not_found(job_id)
        return persisted

    @app.get("/jobs/{job_id}/result", response_model=JobResult)
    async def job_result(job_id: str) -> JobResult:
        async with store.lock:
            live = store.jobs.get(job_id)
        if live is not None:
            state, result = live.state, live.result
        else:
            persisted = store.get_persisted_job(job_id)
            if persisted is None:
                raise _job_not_found(job_id)
            state, result = persisted.state, store.get_persisted_result(job_id)
        if state not in {JobState.succeeded, JobState.failed, JobState.canceled}:
            raise ApiError(
                status_code=409,
                code="job_not_terminal",
                message=(
                    "Job result is only available after the job reaches a terminal "
                    "state."
                ),
            )
        if result is None:
            raise ApiError(
                status_code=404,
                code="job_result_not_found",
                message=f"Job result not found: {job_id}",
            )
        return result

    @app.post("/jobs/{job_id}/cancel", response_model=JobStatus)
    async def cancel_job(job_id: str) -> JobStatus:
        async with store.lock:
            job = store.jobs.get(job_id)
            cancellable = job is not None and job.state in {
                JobState.queued,
                JobState.running,
            }
            if job is not None and cancellable:
                job.state = JobState.canceled
                job.progress = min(job.progress, 1.0)
                job.logs_tail.append("Job canceled.")
                store.persist_job(job)
        if job is None:
            # No live handle: a job persisted by a previous process (already
            # terminal after startup reconciliation) — cancel is a no-op.
            persisted = store.get_persisted_job(job_id)
            if persisted is None:
                raise _job_not_found(job_id)
            return persisted
        # Signal the task outside the lock; the worker re-checks `canceled`
        # under the lock before writing any terminal state (BUG-D).
        if cancellable and job.task is not None:
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
        except ValueError as exc:
            raise ApiError(
                status_code=400,
                code="invalid_run_id",
                message=str(exc),
                details={"run_id": body.run_id},
            ) from exc
        except FileNotFoundError as exc:
            raise ApiError(
                status_code=404,
                code="run_mcap_not_found",
                message=str(exc),
                details={"run_id": body.run_id},
            ) from exc

    return app


def _job_not_found(job_id: str) -> ApiError:
    """Build the unified 404 for an unknown job id."""
    return ApiError(
        status_code=404,
        code="job_not_found",
        message=f"Job not found: {job_id}",
        details={"job_id": job_id},
    )


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


def _release_slot_when_done(task: asyncio.Task[dict], slots: asyncio.Semaphore) -> None:
    """Release a concurrency slot when *task* truly finishes — not when the
    awaiting coroutine is cancelled.

    A job's heavy work runs in a threadpool (``asyncio.to_thread``), and those
    threads CANNOT be cancelled: a timeout/cancel unblocks the awaiter but the
    thread keeps running. We deliberately keep such a runaway thread's slot
    occupied (rather than admitting fresh work on top of a thread we can't stop)
    by releasing only from the task's done-callback, which fires on the event
    loop once the thread actually completes. (``asyncio.Semaphore`` is not safe
    to release from the worker thread itself, so a loop-side callback is the
    correct equivalent of a thread-side ``finally``.)
    """
    if task.done():
        slots.release()
        return

    def _release(t: asyncio.Task[dict]) -> None:
        slots.release()
        # Consume any exception so an abandoned (timed-out/cancelled) runner that
        # later fails doesn't log "Task exception was never retrieved".
        if not t.cancelled():
            t.exception()

    task.add_done_callback(_release)


async def _execute_job(
    job: JobRecord,
    store: RunnerStore,
    data_dir: Path,
    *,
    slots: asyncio.Semaphore | None = None,
    timeout_s: float = _DEFAULT_JOB_TIMEOUT_S,
) -> None:
    """Run a queued job in the process-local async worker.

    *slots* bounds how many jobs run concurrently and *timeout_s* caps each
    job's wall-clock time (DORA-M1). A job past the timeout is failed with
    ``reason: timeout``; since threadpool work can't be interrupted, it keeps its
    concurrency slot until the thread finishes (see _release_slot_when_done).
    """
    if slots is None:
        slots = asyncio.Semaphore(_DEFAULT_MAX_CONCURRENCY)
    try:
        async with store.lock:
            # Cancelled before the worker started (between create and here) —
            # honour it instead of clobbering canceled with running (BUG-D).
            if job.state == JobState.canceled:
                return
            job.state = JobState.running
            job.progress = 0.1
            job.logs_tail.append("Job started.")
            store.persist_job(job)
        # Registry dispatch (OL-④): one uniform runner per pipeline, no per-type
        # branching here. /jobs already rejected non-runnable pipelines, but guard
        # in case a placeholder slipped through.
        pipeline = DEFAULT_REGISTRY.get(job.pipeline)
        if pipeline is None or pipeline.runner is None:
            raise ApiError(
                status_code=400,
                code="pipeline_unavailable",
                message=f"Pipeline is not implemented: {job.pipeline}",
            )
        await slots.acquire()
        runner_task: asyncio.Task[dict] = asyncio.ensure_future(
            pipeline.runner(job, store, data_dir)
        )
        try:
            # shield: a timeout/cancel unblocks this await but must NOT cancel the
            # non-cancellable threadpool work running underneath the runner.
            result = await asyncio.wait_for(asyncio.shield(runner_task), timeout_s)
        finally:
            _release_slot_when_done(runner_task, slots)
        validated = JobResult.model_validate(result)
        async with store.lock:
            # Cancelled while the work ran in the threadpool (which can't be
            # interrupted): keep it canceled rather than clobber with succeeded.
            if job.state == JobState.canceled:
                return
            job.result = validated
            job.progress = 1.0
            job.state = JobState.succeeded
            job.logs_tail.append("Job succeeded.")
            store.persist_job(job)
    except TimeoutError:
        async with store.lock:
            # A concurrent cancel must win over a timeout (BUG-D).
            if job.state == JobState.canceled:
                return
            job.state = JobState.failed
            job.progress = 1.0
            job.logs_tail.append(f"Job timed out after {timeout_s:g}s.")
            job.result = JobResult(
                summary={
                    "result": "fail",
                    "reason": "timeout",
                    "error": {
                        "code": "job_timeout",
                        "message": f"Job exceeded the {timeout_s:g}s timeout.",
                    },
                },
                artifacts=[],
            )
            store.persist_job(job)
    except asyncio.CancelledError:
        # Reached because cancel_job already set `canceled` under the lock and
        # cancelled the task; just record it (idempotent).
        job.state = JobState.canceled
        job.logs_tail.append("Job canceled.")
        store.persist_job(job)
    except ApiError as exc:
        async with store.lock:
            # A concurrent cancel must win over a failing worker (BUG-D): don't
            # clobber `canceled` with `failed`.
            if job.state == JobState.canceled:
                return
            job.state = JobState.failed
            job.progress = 1.0
            job.logs_tail.append(exc.message)
            job.result = JobResult(
                summary={"result": "fail", "error": exc.to_model().model_dump()},
                artifacts=[],
            )
            store.persist_job(job)
    except Exception as exc:  # noqa: BLE001 - job failures are status, not 500s.
        async with store.lock:
            if job.state == JobState.canceled:
                return
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
            store.persist_job(job)


def main() -> None:
    """Run the service with uvicorn, binding host/port from config.

    The app (and its file-backed SQLite store) is built here rather than at module
    import, so merely importing ``dora_runner.main`` — as the tests do — has no
    filesystem side effect. The launch entry point is ``python -m dora_runner.main``.
    """
    import uvicorn

    settings = get_settings()
    app = create_dora_app(settings)
    uvicorn.run(app, host=settings.bind_host, port=settings.dora_runner_port)


if __name__ == "__main__":
    main()
