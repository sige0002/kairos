# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Job cancellation semantics.

BUG-D: a cancelled job's state must not be clobbered by the worker — it
re-checks `canceled` under `store.lock` before writing `running` or any
terminal state.

S1-1 (timing sweep 2026-08-07): cancelling RUNNING work is cooperative. The
API sets ``cancel_event`` and answers with the job still ``running``
(``cancel_requested: true``); only the worker's own JobCanceled checkpoint —
the moment the work is actually dead — writes ``canceled``. The old behaviour
flipped the label immediately while the threadpool/subprocess ran to
completion, which released the capture lease under a job that was still
writing.
"""

from __future__ import annotations

import asyncio
import types
from pathlib import Path

import pytest
from dora_runner.main import _execute_job, create_dora_app
from dora_runner.models import JobCanceled
from dora_runner.store import JobRecord, RunnerStore
from fastapi.testclient import TestClient
from kairos_common import JobState, Settings
from kairos_common.ids import new_capture_id

# A capture_id is a UUIDv7 everywhere it is used as a key or path segment (§1).
CAPTURE_ID = new_capture_id()


def test_execute_job_skips_a_precanceled_job() -> None:
    """A job cancelled before the worker starts is left canceled (not run)."""
    store = RunnerStore()
    job = JobRecord(
        job_id="j1",
        capture_id=CAPTURE_ID,
        pipeline="fast_validation",
        params={},
    )
    job.state = JobState.canceled  # cancelled between create and worker start

    asyncio.run(_execute_job(job, store, Path("/nonexistent")))

    # The worker returned immediately: no running/succeeded/failed transition,
    # and no result was written.
    assert job.state is JobState.canceled
    assert job.result is None


def _stub_registry(runner) -> types.SimpleNamespace:
    """A registry whose every pipeline is runnable and runs *runner*."""
    pipeline = types.SimpleNamespace(
        id="stub", runner=runner, params_schema={"type": "object"}
    )
    return types.SimpleNamespace(
        get=lambda pipeline_id: pipeline,
        runnable=lambda pipeline_id: True,
    )


def test_cancel_of_running_work_lands_when_the_work_stops(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`canceled` is written by the worker's checkpoint, not by the request."""
    store = RunnerStore()
    job = JobRecord(job_id="j2", capture_id=CAPTURE_ID, pipeline="stub", params={})
    store.jobs[job.job_id] = job
    started = asyncio.Event()

    async def runner(j: JobRecord, s: RunnerStore, d: Path) -> dict:
        started.set()
        # Cooperative worker: stop at the next checkpoint after the event.
        while not j.cancel_event.is_set():
            await asyncio.sleep(0.005)
        raise JobCanceled

    monkeypatch.setattr("dora_runner.main.DEFAULT_REGISTRY", _stub_registry(runner))

    async def scenario() -> None:
        task = asyncio.create_task(_execute_job(job, store, Path("/nonexistent")))
        await started.wait()
        # The API's cancel: a REQUEST. The state must still be running here —
        # the work has not stopped yet.
        job.cancel_requested = True
        job.cancel_event.set()
        assert job.state is JobState.running
        await task

    asyncio.run(scenario())
    assert job.state is JobState.canceled
    assert job.status().cancel_requested is True


def test_work_that_finishes_before_the_checkpoint_stays_succeeded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A cancel that lands after the work is done does not rewrite history."""
    store = RunnerStore()
    job = JobRecord(job_id="j3", capture_id=CAPTURE_ID, pipeline="stub", params={})
    store.jobs[job.job_id] = job
    started = asyncio.Event()
    release = asyncio.Event()

    async def runner(j: JobRecord, s: RunnerStore, d: Path) -> dict:
        started.set()
        await release.wait()
        return {"summary": {"result": "pass"}, "artifacts": []}

    monkeypatch.setattr("dora_runner.main.DEFAULT_REGISTRY", _stub_registry(runner))

    async def scenario() -> None:
        task = asyncio.create_task(_execute_job(job, store, Path("/nonexistent")))
        await started.wait()
        job.cancel_requested = True
        job.cancel_event.set()
        # The worker never reaches a checkpoint — the work simply completes.
        release.set()
        await task

    asyncio.run(scenario())
    assert job.state is JobState.succeeded


def test_cancel_endpoint_requests_then_reports_the_true_end(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """POST /cancel on a running job answers running+cancel_requested, and the
    job turns canceled only when the worker actually stops."""
    started = asyncio.Event()

    async def runner(j: JobRecord, s: RunnerStore, d: Path) -> dict:
        started.set()
        while not j.cancel_event.is_set():
            await asyncio.sleep(0.005)
        raise JobCanceled

    monkeypatch.setattr("dora_runner.main.DEFAULT_REGISTRY", _stub_registry(runner))
    app = create_dora_app(Settings(data_dir=str(tmp_path)), store=RunnerStore())
    with TestClient(app) as client:
        job_id = client.post(
            "/jobs", json={"capture_id": CAPTURE_ID, "pipeline": "stub", "params": {}}
        ).json()["job_id"]

        def wait_state(predicate, budget_s: float = 5.0) -> dict:
            import time as _time

            deadline = _time.monotonic() + budget_s
            while _time.monotonic() < deadline:
                body = client.get(f"/jobs/{job_id}/status").json()
                if predicate(body):
                    return body
                _time.sleep(0.01)
            raise AssertionError(f"job never reached the expected state: {body}")

        wait_state(lambda b: b["state"] == "running")
        first = client.post(f"/jobs/{job_id}/cancel").json()
        # The request is acknowledged, not fabricated: still running.
        assert first["state"] == "running"
        assert first["cancel_requested"] is True
        # ... and the true end arrives when the worker stops.
        final = wait_state(lambda b: b["state"] == "canceled")
        assert final["cancel_requested"] is True
