# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Durable Validation Run state only settles from each capture's latest attempt."""

from __future__ import annotations

import asyncio
from pathlib import Path

from api_orchestrator.models import JobResult, JobStatus
from api_orchestrator.validation_run_store import ValidationRunStore
from api_orchestrator.validation_supervisor import ValidationRunSupervisor
from kairos_common import JobState
from kairos_common.ids import new_capture_id


def _status(
    capture_id: str, state: JobState, *, active: bool | None, job_id: str = "job_test"
) -> JobStatus:
    return JobStatus(
        job_id=job_id,
        capture_id=capture_id,
        pipeline="fast_validation",
        state=state,
        progress=1.0,
        logs_tail=[],
        execution_active=active,
    )


def test_retry_uses_only_latest_attempt_and_latest_success_wins(tmp_path: Path) -> None:
    """History never creates duplicate retries or leaves a run falsely active."""
    store = ValidationRunStore(tmp_path / "validation_runs.db")
    capture_id = new_capture_id()
    run = store.create_run("fast_validation", [capture_id], {})
    first = run.jobs[0]
    store.record_remote_status(
        first.run_job_id,
        _status(capture_id, JobState.failed, active=False),
        JobResult(summary={"result": "fail"}, artifacts=[]),
    )

    retried = store.retry_failed(run.run_id)
    assert [(job.attempt, job.dispatch_state) for job in retried.jobs] == [
        (1, "accepted"),
        (2, "pending_lease"),
    ]
    second = retried.jobs[-1]
    store.record_remote_status(
        second.run_job_id,
        _status(capture_id, JobState.succeeded, active=False, job_id="job_retry"),
        JobResult(summary={"result": "pass"}, artifacts=[]),
    )

    settled = store.get_run_or_raise(run.run_id)
    assert settled.state == "finished"
    again = store.retry_failed(run.run_id)
    assert [job.attempt for job in again.jobs] == [1, 2]


def test_old_runner_terminal_is_held_once_then_explicitly_released(
    tmp_path: Path,
) -> None:
    """An old runner's missing execution flag is safe but cannot stall forever."""
    store = ValidationRunStore(tmp_path / "validation_runs.db")
    capture_id = new_capture_id()
    run = store.create_run("fast_validation", [capture_id], {})
    child = run.jobs[0]
    store.record_remote_status(
        child.run_job_id,
        _status(capture_id, JobState.failed, active=None),
        JobResult(summary={"result": "fail"}, artifacts=[]),
    )
    assert store.get_run_or_raise(run.run_id).state == "running"

    store.mark_legacy_lease_released(child.run_job_id)
    assert store.get_run_or_raise(run.run_id).state == "finished"


def test_finished_cancel_is_an_idempotent_noop(tmp_path: Path) -> None:
    store = ValidationRunStore(tmp_path / "validation_runs.db")
    capture_id = new_capture_id()
    run = store.create_run("fast_validation", [capture_id], {})
    child = run.jobs[0]
    store.record_remote_status(
        child.run_job_id,
        _status(capture_id, JobState.succeeded, active=False),
        JobResult(summary={"result": "pass"}, artifacts=[]),
    )

    canceled = store.request_cancel(run.run_id)

    assert canceled.state == "finished"
    assert canceled.cancel_requested is False
    assert store.list_runs(active=True) == []


def test_submission_payload_is_frozen_for_idempotent_remote_retry(
    tmp_path: Path,
) -> None:
    store = ValidationRunStore(tmp_path / "validation_runs.db")
    run = store.create_run("fast_validation", [new_capture_id()], {})
    child_id = run.jobs[0].run_job_id

    first = store.freeze_submission_payload(child_id, {"params": {"template": "A"}})
    retried = store.freeze_submission_payload(child_id, {"params": {"template": "B"}})

    assert first == {"params": {"template": "A"}}
    assert retried == first


def test_request_id_returns_the_original_intent_or_a_conflict(tmp_path: Path) -> None:
    """A response-loss retry cannot make another set of child submissions."""
    store = ValidationRunStore(tmp_path / "validation_runs.db")
    capture_id = new_capture_id()
    first = store.create_run(
        "fast_validation", [capture_id], {"level": "quick"}, "click_1"
    )
    retried = store.create_run(
        "fast_validation", [capture_id], {"level": "quick"}, "click_1"
    )
    assert retried.run_id == first.run_id
    assert len(retried.jobs) == 1

    try:
        store.create_run("fast_validation", [capture_id], {}, "click_1")
    except ValueError as exc:
        assert str(exc) == "validation_run_idempotency_conflict"
    else:  # pragma: no cover - makes the required conflict explicit
        raise AssertionError("different request_id payload was accepted")


def test_run_keeps_selection_provenance(tmp_path: Path) -> None:
    """The resolved target source remains visible after durable creation."""
    store = ValidationRunStore(tmp_path / "validation_runs.db")
    run = store.create_run(
        "fast_validation", ["capture-1"], {}, "selection-small", "selection_1"
    )
    assert run.selection_id == "selection_1"
    assert len(run.jobs) == 1


def test_unreachable_runner_cannot_renew_an_expired_safety_hold(tmp_path: Path) -> None:
    """A down runner settles the durable intent and releases its delete hold."""
    store = ValidationRunStore(tmp_path / "validation_runs.db")
    capture_id = new_capture_id()
    run = store.create_run("fast_validation", [capture_id], {})
    child = run.jobs[0]
    store._update_child(child.run_job_id, safety_deadline_at="2000-01-01T00:00:00Z")

    class CaptureLeases:
        released: list[tuple[str, str]] = []

        def release_lease(self, capture_id: str, owner: str) -> bool:
            self.released.append((capture_id, owner))
            return True

    leases = CaptureLeases()
    supervisor = ValidationRunSupervisor(
        store, leases, object(), tmp_path, instance_id="local", config_catalog=object()
    )
    asyncio.run(supervisor._sync(store.active_jobs()[0]))

    settled = store.get_run_or_raise(run.run_id)
    assert settled.state == "finished"
    assert settled.jobs[0].failure_code == "submission_unknown_timeout"
    assert leases.released == [(capture_id, f"validation-run:{child.run_job_id}")]


def test_startup_reacquires_local_hold_without_waiting_for_runner(
    tmp_path: Path,
) -> None:
    """A runner outage cannot put the API readiness path behind remote polling."""
    store = ValidationRunStore(tmp_path / "validation_runs.db")
    capture_id = new_capture_id()
    run = store.create_run("fast_validation", [capture_id], {})

    class CaptureLeases:
        acquired: list[tuple[str, str]] = []

        def acquire_lease(self, capture_id: str, owner: str, *, ttl_s: float) -> bool:
            self.acquired.append((capture_id, owner))
            return True

    leases = CaptureLeases()
    supervisor = ValidationRunSupervisor(
        store, leases, object(), tmp_path, instance_id="local", config_catalog=object()
    )

    async def start_and_stop() -> None:
        await supervisor.start()
        await supervisor.stop()

    asyncio.run(start_and_stop())
    assert leases.acquired == [(capture_id, f"validation-run:{run.jobs[0].run_job_id}")]
