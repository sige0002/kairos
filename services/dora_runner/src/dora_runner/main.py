# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""dora_runner service."""

from __future__ import annotations

import asyncio
import logging
import os
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Query, status
from kairos_common import ApiError, JobState, Settings, create_app, get_settings
from kairos_common.ids import is_uuid7

from dora_runner.bagflow_runtime import DoraEndpoint, DoraStack, bagflow_available
from dora_runner.mcap_utils import CaptureBytesMissing
from dora_runner.models import (
    JobCanceled,
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
# 4, not 2, since §7.1's lease became shared (rev.2.15): the N camera encoders
# of ONE recording now run in parallel, so two slots would serialise the very
# case the change exists for. N is 2-5 in practice, so 4 covers the usual
# recording without letting a bulk submission thrash one disk.
_DEFAULT_MAX_CONCURRENCY = 4
_DEFAULT_JOB_TIMEOUT_S = 900.0

# After the job deadline passes, how long the runner waits for the worker to
# honour the cooperative stop (the same cancel_event an API cancel sets) before
# giving up on it. Checkpoints are dense — the bagflow watcher polls its
# subprocess every 0.5 s, the decoding pipelines check per message/frame — so
# this only has to absorb one slow checkpoint, not the job itself. A worker
# that produces its RESULT inside this window is recorded as succeeded: the
# deadline bounds wall-clock spend, it does not exist to relabel finished work
# as failed (timing sweep S2-4).
_TIMEOUT_STOP_GRACE_S = 30.0


def _job_max_concurrency() -> int:
    """Max jobs executed at once (``KAIROS_DORA_MAX_CONCURRENCY``, default 4)."""
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


async def _readyz() -> dict[str, object]:
    """Report dora_runner readiness, honest about dora availability (DORA-M2).

    The service is READY without the dora CLI — dataflows fall back to the
    in-process interpreter — so ``status`` stays ``ready``; the ``dora``
    component reports the real executor mode (``available`` vs ``in-process``)
    instead of a fixed ``ok`` that implied dora was bundled.
    """
    dora = "available" if dora_cli_available() else "in-process"
    # `bagflow` is separate from `dora`: plugin dataflows degrade to the
    # in-process interpreter without the CLI, but the validation gates
    # cannot — they need the bagflow binaries too (see
    # registry._fast_validation_pipeline / _full_validation_pipeline).
    bagflow = "available" if bagflow_available() else "unavailable"
    return {
        "status": "ready",
        "components": {"dora": dora, "bagflow": bagflow},
    }


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
    app = create_app(SERVICE_NAME, settings=settings, readyz=_readyz)
    app.state.runner_store = store
    app.state.data_dir = data_dir
    # Bound how many jobs execute at once, and cap each job's wall-clock budget
    # (DORA-M1). The semaphore is per-app (bound to this app's event loop) so
    # concurrent TestClients don't share a cross-loop primitive.
    job_slots = asyncio.Semaphore(_job_max_concurrency())
    job_timeout_s = _job_timeout_s()

    # The service owns its dora coordinator/daemon (see bagflow_runtime): started
    # here so the first validation job doesn't pay for it, torn down with
    # `dora destroy` so no dataflow (and no /dev/shm it holds) outlives us. A
    # deployment without the binaries never starts anything.
    dora_stack = DoraStack(DoraEndpoint.from_env(), data_dir / ".dora")
    app.state.dora_stack = dora_stack

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        await asyncio.to_thread(dora_stack.start)
        try:
            yield
        finally:
            await asyncio.to_thread(dora_stack.stop)

    app.router.lifespan_context = lifespan

    @app.get("/")
    async def root() -> dict[str, str]:
        return {"service": SERVICE_NAME}

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
        # Refused HERE rather than at the first path join (§10.5): a capture_id
        # is the job's only input, so a value that can never name a capture is a
        # bad request — not a job that is accepted, queued, and then fails.
        if not is_uuid7(body.capture_id):
            raise ApiError(
                status_code=400,
                code="invalid_capture_id",
                message=f"capture_id must be a UUIDv7: {body.capture_id}",
                details={"capture_id": body.capture_id},
            )
        job = JobRecord(
            job_id=f"job_{uuid.uuid4().hex}",
            capture_id=body.capture_id,
            pipeline=body.pipeline,
            params=body.params,
            idempotency_key=body.idempotency_key,
        )
        async with store.lock:
            if body.idempotency_key is not None:
                existing = store.get_job_by_idempotency_key(body.idempotency_key)
                if existing is not None:
                    if (
                        existing.capture_id != body.capture_id
                        or existing.pipeline != body.pipeline
                        or existing.params != body.params
                    ):
                        raise ApiError(
                            status_code=409,
                            code="idempotency_conflict",
                            message=(
                                "idempotency_key was already used for a different job."
                            ),
                            details={"idempotency_key": body.idempotency_key},
                        )
                    return JobCreateResponse(job_id=existing.job_id)
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
        cancel_queued = False
        async with store.lock:
            job = store.jobs.get(job_id)
            if job is not None and job.state == JobState.queued:
                # Not started yet: cancel is immediate, and the worker honours
                # the state before running (BUG-D).
                cancel_queued = True
                job.state = JobState.canceled
                job.progress = min(job.progress, 1.0)
                job.logs_tail.append("Job canceled.")
                store.persist_job(job)
            elif job is not None and job.state == JobState.running:
                # RUNNING work cannot be labelled dead — it has to BE stopped.
                # The old code flipped the state to `canceled` here and left the
                # threadpool/subprocess running to completion (the shield in
                # _execute_job exists so a timeout can't kill it either): the
                # UI stopped polling, the orchestrator released the capture
                # lease, and a later delete renamed a directory the job was
                # still writing. Now cancel REQUESTS: the event stops the work
                # at its next checkpoint, and only the worker's own JobCanceled
                # path writes the terminal state.
                if not job.cancel_requested:
                    job.cancel_requested = True
                    job.logs_tail.append("Cancel requested; stopping the work.")
                    store.persist_job(job)
                job.cancel_event.set()
        if job is None:
            # No live handle: a job persisted by a previous process (already
            # terminal after startup reconciliation) — cancel is a no-op.
            persisted = store.get_persisted_job(job_id)
            if persisted is None:
                raise _job_not_found(job_id)
            return persisted
        # Signal a queued job's task outside the lock; the worker re-checks
        # `canceled` under the lock before writing any terminal state (BUG-D).
        if cancel_queued and job.task is not None:
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
        # to_thread: this reads the capture's MCAP summary from disk, which for
        # a large bag on a busy volume takes seconds. Running it ON the event
        # loop froze every other endpoint for the duration — and past the
        # client's 3 s budget the caller retried, stacking a second parse on a
        # loop that had not finished the first (timing sweep S4). Settlement
        # does the identical read through to_thread already.
        try:
            return await asyncio.to_thread(generate_template, body.capture_id, data_dir)
        except ValueError as exc:
            raise ApiError(
                status_code=400,
                code="invalid_capture_id",
                message=str(exc),
                details={"capture_id": body.capture_id},
            ) from exc
        except FileNotFoundError as exc:
            raise ApiError(
                status_code=404,
                code="capture_mcap_not_found",
                message=str(exc),
                details={"capture_id": body.capture_id},
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


class _JobTimedOut(Exception):
    """A job passed its deadline; ``stopped`` says whether the work then died.

    Distinct from ``JobCanceled`` so the terminal label stays honest: a
    deadline is a FAILURE (``reason: timeout``), an operator cancel is
    ``canceled`` — and when both race, the cancel wins (BUG-D).
    """

    def __init__(self, *, stopped: bool) -> None:
        super().__init__("job timed out")
        self.stopped = stopped


async def _stop_timed_out_job(
    job: JobRecord,
    store: RunnerStore,
    runner_task: asyncio.Task[dict],
    *,
    timeout_s: float,
) -> dict:
    """Deadline passed: cooperatively stop the work, then report what happened.

    The pre-S2-4 timeout only RELABELLED — ``failed (job_timeout)`` while the
    shielded threadpool work ran to completion holding its slot, which under
    the full-length video encode (VIDEO_MAX_FRAMES=0) meant a false failure
    plus one of four slots dead for however long the encode took. Route the
    deadline through the same cooperative machinery an API cancel uses: set
    ``cancel_event``, let the worker kill its subprocess / stop decoding at
    the next checkpoint, and wait a short grace window.

    Returns the worker's result when it FINISHES inside that window (a late
    success is a success). Raises :class:`_JobTimedOut` when the work stopped
    (``stopped=True``) or ignored the stop past the grace window
    (``stopped=False``). Raises :class:`JobCanceled` untouched when an API
    cancel had already requested the stop — that label belongs to the cancel.
    """
    api_cancel_first = job.cancel_event.is_set()
    async with store.lock:
        if not job.cancel_requested:
            job.cancel_requested = True
            job.logs_tail.append(
                f"Job passed the {timeout_s:g}s deadline; stopping the work."
            )
            store.persist_job(job)
    job.cancel_event.set()
    try:
        return await asyncio.wait_for(
            asyncio.shield(runner_task), _TIMEOUT_STOP_GRACE_S
        )
    except JobCanceled:
        if api_cancel_first:
            raise
        raise _JobTimedOut(stopped=True) from None
    except TimeoutError:
        raise _JobTimedOut(stopped=False) from None


def _release_slot_when_done(
    task: asyncio.Task[dict],
    slots: asyncio.Semaphore,
    *,
    job: JobRecord,
    store: RunnerStore,
) -> None:
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

    def mark_execution_stopped() -> None:
        job.execution_active = False
        store.persist_job(job)

    if task.done():
        slots.release()
        mark_execution_stopped()
        return

    def _release(t: asyncio.Task[dict]) -> None:
        slots.release()
        mark_execution_stopped()
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
    job's wall-clock time (DORA-M1). A job past the deadline is STOPPED, not
    just relabelled (S2-4): the runner sets the same ``cancel_event`` an API
    cancel does, the worker kills its subprocess / stops decoding at the next
    checkpoint, and only then is the job failed with ``reason: timeout`` — so
    the slot actually frees. A worker that instead finishes inside the grace
    window is recorded as succeeded. Only a worker that ignores the stop keeps
    its slot until its thread exits (see _release_slot_when_done).
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
        if job.cancel_event.is_set():
            # Cancelled while waiting for a slot: nothing has run, so honour it
            # before spawning work that would have to be stopped again.
            slots.release()
            raise JobCanceled
        job.execution_active = True
        store.persist_job(job)
        runner_task: asyncio.Task[dict] = asyncio.ensure_future(
            pipeline.runner(job, store, data_dir)
        )
        try:
            # shield: a timeout/cancel unblocks this await but must NOT cancel the
            # non-cancellable threadpool work running underneath the runner.
            # An API cancel does not cancel this task either — it sets
            # job.cancel_event, and the runner raises JobCanceled from its own
            # checkpoint once the work has actually stopped.
            try:
                result = await asyncio.wait_for(asyncio.shield(runner_task), timeout_s)
            except TimeoutError:
                result = await _stop_timed_out_job(
                    job, store, runner_task, timeout_s=timeout_s
                )
        finally:
            _release_slot_when_done(runner_task, slots, job=job, store=store)
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
    except _JobTimedOut as timed_out:
        async with store.lock:
            # A concurrent cancel must win over a timeout (BUG-D).
            if job.state == JobState.canceled:
                return
            job.state = JobState.failed
            job.progress = 1.0
            if timed_out.stopped:
                detail = "the work was stopped"
            else:
                # The one remaining runaway: a worker that ignored the stop
                # request past the grace window. Its slot stays held until the
                # thread exits (_release_slot_when_done) — say so instead of
                # pretending the timeout freed anything.
                detail = (
                    "the work did not stop within the "
                    f"{_TIMEOUT_STOP_GRACE_S:g}s grace window and is still "
                    "running; its concurrency slot stays held until it exits"
                )
            job.logs_tail.append(f"Job timed out after {timeout_s:g}s; {detail}.")
            job.result = JobResult(
                summary={
                    "result": "fail",
                    "reason": "timeout",
                    "error": {
                        "code": "job_timeout",
                        "message": (
                            f"Job exceeded the {timeout_s:g}s timeout; {detail}."
                        ),
                    },
                },
                artifacts=[],
            )
            store.persist_job(job)
    except JobCanceled:
        async with store.lock:
            # The worker stopped at a cancellation checkpoint (or never
            # started): the work is genuinely dead, so `canceled` is now a
            # fact rather than a label.
            job.state = JobState.canceled
            job.progress = min(job.progress, 1.0)
            job.logs_tail.append("Job canceled; the work was stopped.")
            store.persist_job(job)
    except asyncio.CancelledError:
        # Reached for a QUEUED job only: cancel_job already set `canceled`
        # under the lock and cancelled the task; just record it (idempotent).
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
            # The capture's bytes being gone is a different fact from the
            # pipeline breaking, and the only one the operator can act on
            # without reading a traceback. The message already said so; this
            # makes it machine-readable, at the moment the job actually looked
            # for the files rather than by guessing at submit time.
            code = (
                "capture_missing"
                if isinstance(exc, CaptureBytesMissing)
                else "job_failed"
            )
            job.result = JobResult(
                summary={
                    "result": "fail",
                    "error": {"code": code, "message": str(exc)},
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
