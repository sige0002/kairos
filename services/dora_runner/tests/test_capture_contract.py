# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""The job contract: a capture_id names the source, the outputs and the row.

Contract §10.5. These are the assertions that stop the run_id-keyed layout from
creeping back in: source resolution has exactly one branch, a job request that
does not name a capture is refused at the boundary, and the persisted row is
keyed by the same id the request carried.
"""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path

import pytest
from dora_runner.main import create_dora_app
from dora_runner.mcap_utils import resolve_source_dir
from dora_runner.store import JobRecord, RunnerStore
from fastapi.testclient import TestClient
from kairos_common import JobState, Settings
from kairos_common.ids import new_capture_id

# ---- source resolution (§10.5: objects/<capture_id>, no second branch) -------


def test_resolve_source_dir_is_objects_capture_id(tmp_path: Path) -> None:
    capture_id = new_capture_id()
    expected = tmp_path / "objects" / capture_id
    expected.mkdir(parents=True)
    assert resolve_source_dir(tmp_path, capture_id) == expected


@pytest.mark.parametrize(
    "bad",
    [
        "../../etc",
        "run_20260623_232808",  # a run_id is a display name now (§1)
        "objects/../../etc",
        "",
        "0198f2a0-1234-4abc-8def-0123456789ab",  # UUIDv4, not v7
        "0198F2A0-1234-7ABC-8DEF-0123456789AB",  # uppercase is not canonical
    ],
)
def test_resolve_source_dir_rejects_anything_but_a_uuid7(
    tmp_path: Path, bad: str
) -> None:
    """The guard runs before the join, so nothing can escape ``objects/``."""
    (tmp_path / "objects").mkdir()
    with pytest.raises(ValueError, match="capture_id must be a UUIDv7"):
        resolve_source_dir(tmp_path, bad)


def test_resolve_source_dir_absent_capture_is_not_found(tmp_path: Path) -> None:
    (tmp_path / "objects").mkdir()
    with pytest.raises(FileNotFoundError, match="No capture found"):
        resolve_source_dir(tmp_path, new_capture_id())


# ---- POST /jobs (the boundary) ----------------------------------------------


def test_create_job_rejects_a_non_uuid7_capture_id(tmp_path: Path) -> None:
    """A bad capture_id is a 400, not a job that is queued and then fails.

    Accepting it would put a row in the jobs table and a failure in the UI's
    job list for what is simply a malformed request.
    """
    app = create_dora_app(Settings(data_dir=str(tmp_path)))
    with TestClient(app) as client:
        response = client.post(
            "/jobs",
            json={
                "capture_id": "run_20260623_232808",
                "pipeline": "loss_report",
                "params": {},
            },
        )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_capture_id"


def test_create_job_requires_a_capture_id_field(tmp_path: Path) -> None:
    """``run_id`` is not accepted under any name — there is no compat alias."""
    app = create_dora_app(Settings(data_dir=str(tmp_path)))
    with TestClient(app) as client:
        response = client.post(
            "/jobs",
            json={"run_id": "run_x", "pipeline": "loss_report", "params": {}},
        )
    assert response.status_code == 422


def test_job_status_carries_the_capture_id(tmp_path: Path) -> None:
    """The orchestrator validates this response as its own capture-keyed model."""
    capture_id = new_capture_id()
    app = create_dora_app(Settings(data_dir=str(tmp_path)))
    with TestClient(app) as client:
        created = client.post(
            "/jobs",
            json={
                "capture_id": capture_id,
                "pipeline": "loss_report",
                "params": {},
            },
        )
        assert created.status_code == 201
        status = client.get(f"/jobs/{created.json()['job_id']}/status").json()
    assert status["capture_id"] == capture_id
    assert "run_id" not in status


def test_a_job_whose_capture_vanished_reports_capture_missing(tmp_path: Path) -> None:
    """§9-2: an external ``rm -rf`` leaves a row whose bytes are gone.

    The submission is still accepted — nothing here stats the filesystem on the
    operator's behalf, and a check at submit would race the removal anyway. The
    job then looks for the files, does not find them, and says so with its own
    code: "the recording is gone" is a different fact for a caller than "the
    pipeline broke", and only one of them is the operator's to fix.
    """
    capture_id = new_capture_id()  # no objects/<capture_id>/ on disk at all
    app = create_dora_app(Settings(data_dir=str(tmp_path)))
    with TestClient(app) as client:
        created = client.post(
            "/jobs",
            json={"capture_id": capture_id, "pipeline": "loss_report", "params": {}},
        )
        assert created.status_code == 201
        job_id = created.json()["job_id"]
        for _ in range(200):
            status = client.get(f"/jobs/{job_id}/status").json()
            if status["state"] in {"succeeded", "failed"}:
                break
            time.sleep(0.01)

    assert status["state"] == "failed"
    error = client.get(f"/jobs/{job_id}/result").json()["summary"]["error"]
    assert error["code"] == "capture_missing"
    # The path stays in the message: it is what tells the operator WHERE the
    # bytes were expected.
    assert capture_id in error["message"]


# ---- the runner's own store --------------------------------------------------


def test_persisted_job_round_trips_the_capture_id(tmp_path: Path) -> None:
    store = RunnerStore(tmp_path / "dora_runner.db")
    capture_id = new_capture_id()
    job = JobRecord(
        job_id="j1", capture_id=capture_id, pipeline="loss_report", params={}
    )
    job.state = JobState.running
    store.persist_job(job)

    persisted = store.get_persisted_job("j1")
    assert persisted is not None
    assert persisted.capture_id == capture_id


def test_a_v1_jobs_table_is_recreated_not_migrated(tmp_path: Path) -> None:
    """§8 calls jobs volatile, so the run_id-keyed table is dropped on open.

    Keeping those rows would serve job history pointing at ``recorded/<run_id>``
    — a source layout that no longer exists — and the first ``persist_job``
    would fail on the missing column anyway.
    """
    db_path = tmp_path / "dora_runner.db"
    legacy = sqlite3.connect(db_path)
    legacy.executescript(
        """
        CREATE TABLE jobs (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id TEXT NOT NULL UNIQUE,
            run_id TEXT NOT NULL,
            pipeline TEXT NOT NULL,
            params TEXT NOT NULL DEFAULT '{}',
            state TEXT NOT NULL,
            progress REAL NOT NULL DEFAULT 0,
            logs_tail TEXT NOT NULL DEFAULT '[]',
            result TEXT,
            created_at TEXT,
            updated_at TEXT
        );
        PRAGMA user_version = 1;
        """
    )
    legacy.execute(
        "INSERT INTO jobs (job_id, run_id, pipeline, state) VALUES (?, ?, ?, ?)",
        ("old_job", "run_20260623_232808", "loss_report", "succeeded"),
    )
    legacy.commit()
    legacy.close()

    store = RunnerStore(db_path)
    assert store.get_persisted_job("old_job") is None

    conn = sqlite3.connect(db_path)
    columns = {row[1] for row in conn.execute("PRAGMA table_info(jobs)")}
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    conn.close()
    assert "capture_id" in columns
    assert "run_id" not in columns
    assert version == 2


def test_recreating_the_jobs_table_keeps_validation_templates(tmp_path: Path) -> None:
    """Only ``jobs`` is volatile; the template cache has not changed shape."""
    db_path = tmp_path / "dora_runner.db"
    legacy = sqlite3.connect(db_path)
    legacy.executescript(
        """
        CREATE TABLE jobs (job_id TEXT, run_id TEXT);
        CREATE TABLE validation_templates (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            version INTEGER NOT NULL,
            required_topics TEXT NOT NULL DEFAULT '[]',
            UNIQUE(name, version)
        );
        PRAGMA user_version = 1;
        """
    )
    legacy.execute(
        "INSERT INTO validation_templates (name, version, required_topics) "
        "VALUES ('airoa_hsr', 3, '[]')",
    )
    legacy.commit()
    legacy.close()

    store = RunnerStore(db_path)
    conn = sqlite3.connect(db_path)
    rows = conn.execute("SELECT name FROM validation_templates").fetchall()
    conn.close()
    store.close()
    assert [row[0] for row in rows] == ["airoa_hsr"]
