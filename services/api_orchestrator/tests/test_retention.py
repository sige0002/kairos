"""Retention endpoint: surfaces old, un-exported recordings as candidates only.

The feature is deliberately advisory — ``GET /api/v1/retention`` lists what the
operator MAY want to reclaim; it never deletes and runs no background job. These
tests pin the candidate predicate (terminal state, still in ``recorded/``, older
than ``RETENTION_DAYS``), the ``0``=disabled behavior, and the best-effort sizes.
"""

from __future__ import annotations

from pathlib import Path

import httpx
from api_orchestrator.app_factory import create_orchestrator_app
from api_orchestrator.models import Batch, Episode, Run, RunState
from api_orchestrator.store import RunStore
from conftest import FakeRecorder
from fastapi.testclient import TestClient
from kairos_common import Settings, utc_now_iso8601

_OLD = "2020-01-01T00:00:00.000Z"  # comfortably older than any retention window


def _build(tmp_path: Path, store: RunStore, fake_recorder: FakeRecorder, *, days: int):
    settings = Settings(
        recording_config="/nonexistent/recording.yaml",
        stream_config="/nonexistent/stream.yaml",
        data_dir=str(tmp_path / "data"),
        recorded_dir=str(tmp_path / "data" / "recorded"),
        retention_days=days,
    )
    client = httpx.AsyncClient(transport=httpx.MockTransport(fake_recorder.handler))
    return create_orchestrator_app(settings, store=store, http_client=client)


def _recorded(tmp_path: Path, run_id: str, nbytes: int) -> None:
    run_dir = tmp_path / "data" / "recorded" / run_id
    run_dir.mkdir(parents=True)
    (run_dir / f"{run_id}_0.mcap").write_bytes(b"x" * nbytes)


def test_retention_disabled_returns_empty(
    tmp_path: Path, store: RunStore, fake_recorder: FakeRecorder
) -> None:
    _recorded(tmp_path, "run_old", 100)
    store.create(Run(run_id="run_old", state=RunState.completed, started_at=_OLD))
    app = _build(tmp_path, store, fake_recorder, days=0)
    with TestClient(app) as client:
        body = client.get("/api/v1/retention").json()
    assert body == {"days": 0, "candidates": [], "total_bytes": 0}


def test_retention_surfaces_old_terminal_runs(
    tmp_path: Path, store: RunStore, fake_recorder: FakeRecorder
) -> None:
    # Old + terminal + on disk -> candidate. Sizes are summed.
    _recorded(tmp_path, "run_done", 100)
    _recorded(tmp_path, "run_fail", 40)
    store.create(Run(run_id="run_done", state=RunState.completed, started_at=_OLD))
    store.create(Run(run_id="run_fail", state=RunState.failed, started_at=_OLD))
    # Recent completed run -> NOT a candidate (below the age threshold).
    _recorded(tmp_path, "run_new", 999)
    store.create(
        Run(run_id="run_new", state=RunState.completed, started_at=utc_now_iso8601())
    )
    # Active recording -> never a candidate (non-terminal), even if old. The
    # recorder confirms it is genuinely recording so startup reconciliation
    # leaves it live (an orphaned "recording" row would be interrupted = a
    # legitimate candidate, so it must be truly active to prove the exclusion).
    store.create(Run(run_id="run_live", state=RunState.recording, started_at=_OLD))
    fake_recorder.state = "recording"
    fake_recorder.run_id = "run_live"

    app = _build(tmp_path, store, fake_recorder, days=30)
    with TestClient(app) as client:
        body = client.get("/api/v1/retention").json()

    assert body["days"] == 30
    ids = {c["run_id"] for c in body["candidates"]}
    assert ids == {"run_done", "run_fail"}
    assert body["total_bytes"] == 140
    by_id = {c["run_id"]: c for c in body["candidates"]}
    assert by_id["run_done"]["bytes"] == 100
    assert by_id["run_done"]["state"] == "completed"
    assert by_id["run_fail"]["state"] == "failed"
    assert by_id["run_done"]["has_episode"] is False


def test_retention_reports_has_episode(
    tmp_path: Path, store: RunStore, fake_recorder: FakeRecorder
) -> None:
    _recorded(tmp_path, "run_ep", 10)
    store.create(Run(run_id="run_ep", state=RunState.completed, started_at=_OLD))
    store.create_batch(
        Batch(
            batch_id="b1",
            robot="airoa_hsr",
            project="p",
            task="t",
            created_at=_OLD,
        )
    )
    store.create_episode(
        Episode(
            episode_id="e1",
            batch_id="b1",
            run_id="run_ep",
            index_in_batch=1,
            task_result="success",
            quality="good",
            review_status="pending",
            created_at=_OLD,
            updated_at=_OLD,
        )
    )
    app = _build(tmp_path, store, fake_recorder, days=30)
    with TestClient(app) as client:
        body = client.get("/api/v1/retention").json()
    assert body["candidates"][0]["run_id"] == "run_ep"
    assert body["candidates"][0]["has_episode"] is True


def test_retention_missing_dir_yields_none_bytes(
    tmp_path: Path, store: RunStore, fake_recorder: FakeRecorder
) -> None:
    # An interrupted run whose dir is gone is still surfaced (row = not exported)
    # but reclaims nothing (bytes null, not counted in the total).
    store.create(Run(run_id="run_nodir", state=RunState.interrupted, started_at=_OLD))
    app = _build(tmp_path, store, fake_recorder, days=30)
    with TestClient(app) as client:
        body = client.get("/api/v1/retention").json()
    assert body["candidates"][0]["run_id"] == "run_nodir"
    assert body["candidates"][0]["bytes"] is None
    assert body["total_bytes"] == 0
