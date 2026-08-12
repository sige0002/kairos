# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Job deadline semantics (timing sweep S2-4).

The pre-S2-4 timeout only relabelled: ``failed (job_timeout)`` while the
shielded threadpool work ran to completion holding its concurrency slot —
a false failure plus a slot dead for the length of the work. The deadline now
routes through the same cooperative machinery an API cancel uses: set
``cancel_event``, let the worker stop at its next checkpoint, and report what
ACTUALLY happened — stopped (failed/timeout), finished late (succeeded), or
ignored the stop (failed/timeout, slot honestly still held).
"""

from __future__ import annotations

import asyncio
import types
from pathlib import Path

import pytest
from dora_runner.main import _execute_job
from dora_runner.models import JobCanceled
from dora_runner.store import JobRecord, RunnerStore
from kairos_common import JobState
from kairos_common.ids import new_capture_id

CAPTURE_ID = new_capture_id()


def _stub_registry(runner) -> types.SimpleNamespace:
    """A registry whose every pipeline is runnable and runs *runner*."""
    pipeline = types.SimpleNamespace(runner=runner)
    return types.SimpleNamespace(
        get=lambda pipeline_id: pipeline,
        runnable=lambda pipeline_id: True,
    )


def _job(job_id: str) -> tuple[JobRecord, RunnerStore]:
    store = RunnerStore()
    job = JobRecord(job_id=job_id, capture_id=CAPTURE_ID, pipeline="stub", params={})
    store.jobs[job.job_id] = job
    return job, store


def test_timeout_stops_the_work_then_fails_with_job_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Deadline -> cancel_event -> the worker's checkpoint dies -> failed."""
    job, store = _job("t1")
    stopped = asyncio.Event()

    async def runner(j: JobRecord, s: RunnerStore, d: Path) -> dict:
        # Cooperative worker: never finishes on its own, dies at a checkpoint.
        while not j.cancel_event.is_set():
            await asyncio.sleep(0.005)
        stopped.set()
        raise JobCanceled

    monkeypatch.setattr("dora_runner.main.DEFAULT_REGISTRY", _stub_registry(runner))
    asyncio.run(_execute_job(job, store, Path("/nonexistent"), timeout_s=0.05))

    assert stopped.is_set()  # the deadline actually reached the work
    assert job.state is JobState.failed
    assert job.result is not None
    assert job.result.summary["reason"] == "timeout"
    assert job.result.summary["error"]["code"] == "job_timeout"
    assert "the work was stopped" in job.result.summary["error"]["message"]
    # The stop request is visible on the status, like an API cancel's.
    assert job.status().cancel_requested is True


def test_late_success_inside_the_grace_window_stays_succeeded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The deadline bounds spend; it does not relabel finished work as failed."""
    job, store = _job("t2")

    async def runner(j: JobRecord, s: RunnerStore, d: Path) -> dict:
        # Ignores checkpoints but FINISHES shortly after the deadline.
        await asyncio.sleep(0.1)
        return {"summary": {"result": "pass"}, "artifacts": []}

    monkeypatch.setattr("dora_runner.main.DEFAULT_REGISTRY", _stub_registry(runner))
    asyncio.run(_execute_job(job, store, Path("/nonexistent"), timeout_s=0.05))

    assert job.state is JobState.succeeded
    assert job.result is not None
    assert job.result.summary["result"] == "pass"


def test_runaway_work_is_reported_as_still_running(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A worker that ignores the stop past the grace window: failed, honestly."""
    job, store = _job("t3")
    release = asyncio.Event()

    async def runner(j: JobRecord, s: RunnerStore, d: Path) -> dict:
        await release.wait()
        return {"summary": {"result": "pass"}, "artifacts": []}

    monkeypatch.setattr("dora_runner.main.DEFAULT_REGISTRY", _stub_registry(runner))
    monkeypatch.setattr("dora_runner.main._TIMEOUT_STOP_GRACE_S", 0.05)

    async def scenario() -> None:
        await _execute_job(job, store, Path("/nonexistent"), timeout_s=0.05)
        # The terminal state landed while the work is STILL running.
        assert job.state is JobState.failed
        release.set()  # let the runner task finish so asyncio.run can close

    asyncio.run(scenario())
    assert job.result is not None
    assert job.result.summary["reason"] == "timeout"
    assert "still running" in job.result.summary["error"]["message"]


def test_api_cancel_that_beat_the_deadline_keeps_the_canceled_label(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When an operator cancel raced the deadline, the end is ``canceled``."""
    job, store = _job("t4")
    started = asyncio.Event()

    async def runner(j: JobRecord, s: RunnerStore, d: Path) -> dict:
        started.set()
        # Reaches its checkpoint only AFTER the deadline has passed.
        await asyncio.sleep(0.1)
        raise JobCanceled

    monkeypatch.setattr("dora_runner.main.DEFAULT_REGISTRY", _stub_registry(runner))

    async def scenario() -> None:
        task = asyncio.create_task(
            _execute_job(job, store, Path("/nonexistent"), timeout_s=0.05)
        )
        await started.wait()
        # The API's cancel lands before the deadline does.
        job.cancel_requested = True
        job.cancel_event.set()
        await task

    asyncio.run(scenario())
    assert job.state is JobState.canceled
