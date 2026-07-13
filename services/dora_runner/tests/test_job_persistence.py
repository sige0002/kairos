"""Job/template persistence + restart reconciliation for dora_runner.

The store is SQLite-backed, so a restart no longer orphans in-flight work (F4).
A job the previous process left ``queued``/``running`` is reconciled to a terminal
``failed`` carrying an honest interrupted reason. Because that lands on ``failed``
(the shared ``JobState`` has no ``interrupted`` member) with the cause under
``summary.error``, the orchestrator's ``run_job_to_completion`` — which treats
succeeded/failed/canceled as terminal and reads ``summary.error`` via
``datasets._job_failure_reason`` — and the Validation UI's generic renderer surface
it to the user with no changes on their side. These tests exercise that path.
"""

from __future__ import annotations

import asyncio
import time
from pathlib import Path

from dora_runner.main import create_dora_app
from dora_runner.models import JobResult, RequiredTopicTemplate, ValidationTemplate
from dora_runner.store import JobRecord, RunnerStore
from fastapi.testclient import TestClient
from kairos_common import JobState, Settings


def _running_job(job_id: str) -> JobRecord:
    """A JobRecord in the ``running`` state, as the worker would have left it."""
    job = JobRecord(
        job_id=job_id, run_id="run_x", pipeline="fast_validation", params={}
    )
    job.state = JobState.running
    job.progress = 0.1
    job.logs_tail = ["Job started."]
    return job


def test_reconcile_marks_inflight_jobs_failed_interrupted(tmp_path: Path) -> None:
    """Queued/running rows become failed+interrupted; status/result serve it."""
    db = str(tmp_path / "dora_runner.db")
    store = RunnerStore(db)
    store.persist_job(
        JobRecord(job_id="j_queued", run_id="r", pipeline="fast_validation", params={})
    )
    store.persist_job(_running_job("j_running"))
    store.close()

    # Restart: a fresh store on the same file reconciles both orphans.
    reopened = RunnerStore(db)
    assert reopened.reconcile_interrupted_jobs() == 2
    for job_id in ("j_queued", "j_running"):
        status = reopened.get_persisted_job(job_id)
        assert status is not None and status.state is JobState.failed
        result = reopened.get_persisted_result(job_id)
        assert result is not None
        assert result.summary["reason"] == "interrupted"
        # Exactly where the orchestrator's _job_failure_reason reads the cause.
        assert result.summary["error"]["code"] == "job_interrupted"
        assert result.summary["error"]["message"]
        # The interrupted note is appended to the preserved logs_tail (req #4).
        assert any("restarted" in line for line in status.logs_tail)


def test_reconcile_leaves_terminal_jobs_untouched(tmp_path: Path) -> None:
    """A succeeded row survives a restart and reconcile is idempotent."""
    db = str(tmp_path / "dora_runner.db")
    store = RunnerStore(db)
    done = JobRecord(job_id="j_done", run_id="r", pipeline="fast_validation", params={})
    done.state = JobState.succeeded
    done.progress = 1.0
    done.result = JobResult(
        summary={"result": "pass"}, artifacts=["/data/report/x/summary.json"]
    )
    store.persist_job(done)
    store.close()

    reopened = RunnerStore(db)
    assert reopened.reconcile_interrupted_jobs() == 0
    status = reopened.get_persisted_job("j_done")
    assert status is not None and status.state is JobState.succeeded
    result = reopened.get_persisted_result("j_done")
    assert result is not None and result.summary["result"] == "pass"
    # A second reconcile is still a no-op.
    assert reopened.reconcile_interrupted_jobs() == 0


def test_app_restart_surfaces_interrupted_via_http(tmp_path: Path) -> None:
    """create_dora_app reconciles at startup; /status and /result serve it."""
    data_dir = tmp_path
    pre = RunnerStore(str(data_dir / "dora_runner.db"))
    pre.persist_job(_running_job("j_inflight"))
    pre.close()

    app = create_dora_app(Settings(data_dir=str(data_dir)))
    with TestClient(app) as client:
        status = client.get("/jobs/j_inflight/status")
        assert status.status_code == 200
        assert status.json()["state"] == "failed"

        result = client.get("/jobs/j_inflight/result")
        assert result.status_code == 200
        summary = result.json()["summary"]
        assert summary["reason"] == "interrupted"
        assert summary["error"]["code"] == "job_interrupted"


def test_cancel_of_restarted_job_is_noop(tmp_path: Path) -> None:
    """Cancelling a job with no live handle returns its terminal state; 404 else."""
    data_dir = tmp_path
    pre = RunnerStore(str(data_dir / "dora_runner.db"))
    pre.persist_job(_running_job("j_inflight"))
    pre.close()

    app = create_dora_app(Settings(data_dir=str(data_dir)))
    with TestClient(app) as client:
        resp = client.post("/jobs/j_inflight/cancel")
        assert resp.status_code == 200
        assert resp.json()["state"] == "failed"
        assert client.post("/jobs/j_missing/cancel").status_code == 404


def test_completed_job_survives_restart(tmp_path: Path) -> None:
    """A job run to completion is served from SQLite after the live handle is gone.

    Uses a video_check job with no topic, which the worker fails fast on
    (``topic_required``) with no MCAP needed — so it exercises the real
    create -> running -> terminal persistence path end to end.
    """
    data_dir = tmp_path
    app = create_dora_app(Settings(data_dir=str(data_dir)))
    with TestClient(app) as client:
        created = client.post(
            "/jobs",
            json={"run_id": "run_x", "pipeline": "video_check", "params": {}},
        )
        assert created.status_code == 201
        job_id = created.json()["job_id"]
        state = ""
        for _ in range(100):
            state = client.get(f"/jobs/{job_id}/status").json()["state"]
            if state in {"succeeded", "failed"}:
                break
            time.sleep(0.05)
        assert state == "failed"

    # Restart on the same data dir: the live handle is gone, but the persisted
    # terminal row still serves status/result (reconcile leaves it untouched).
    restarted = create_dora_app(Settings(data_dir=str(data_dir)))
    with TestClient(restarted) as client:
        assert client.get(f"/jobs/{job_id}/status").json()["state"] == "failed"
        body = client.get(f"/jobs/{job_id}/result").json()
        assert body["summary"]["error"]["error"]["code"] == "topic_required"


def test_templates_persist_across_restart(tmp_path: Path) -> None:
    """A validation template written before a restart is readable afterwards."""
    db = str(tmp_path / "dora_runner.db")
    store = RunnerStore(db)
    template = ValidationTemplate(
        name="hsr_teleop_v1",
        version=1,
        required_topics=[RequiredTopicTemplate(name="/joint_states")],
    )
    asyncio.run(store.add_template(template))
    store.close()

    reopened = RunnerStore(db)
    got = asyncio.run(reopened.get_template("hsr_teleop_v1"))
    assert got is not None and got.version == 1
    assert got.required_topics[0].name == "/joint_states"
    templates, cursor = asyncio.run(reopened.list_templates(50, None))
    assert [t.name for t in templates] == ["hsr_teleop_v1"]
    assert cursor is None
