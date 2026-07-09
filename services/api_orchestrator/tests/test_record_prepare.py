"""Two-phase start: ``POST /api/v1/record/prepare`` + the extended ``start``.

``prepare`` arms the recorder ahead of time (see ``docs/specs/ja/
rosbag2_recorder.md``, two-phase start). The orchestrator keeps prepare state
in memory only (``RunService._prepared``) — no ``Run`` row exists until a
matching ``start()`` actually persists one. These tests exercise the match /
no-match / collision-fallback paths and the ``stop()`` disarm-while-armed path.
"""

from __future__ import annotations

from unittest.mock import patch

from api_orchestrator.models import Run, RunState
from api_orchestrator.runs import RunService
from api_orchestrator.store import RunStore
from conftest import FakeRecorder
from fastapi import FastAPI
from fastapi.testclient import TestClient


def test_prepare_arms_without_creating_a_run_row(
    client: TestClient, fake_recorder: FakeRecorder, store: RunStore
) -> None:
    """A bare ``prepare()`` call arms the recorder but persists nothing."""
    resp = client.post(
        "/api/v1/record/prepare", json={"topics": ["/tf"], "compression": "none"}
    )
    assert resp.status_code == 200
    body = resp.json()

    assert body["state"] == "armed"
    assert body["run_id"].startswith("run_")
    assert body["disarm_at"] == fake_recorder.disarm_at
    assert body["arming"] == fake_recorder.prepare_arming
    # The recorder was handed the orchestrator-allocated run_id.
    assert fake_recorder.last_prepare_payload["run_id"] == body["run_id"]
    assert fake_recorder.prepare_call_count == 1
    # No DB row exists yet -- prepare state lives only in memory.
    assert store.get(body["run_id"]) is None


def test_prepare_then_matching_start_reuses_prepared_run_id(
    client: TestClient, fake_recorder: FakeRecorder, store: RunStore
) -> None:
    """A ``start()`` matching the earlier ``prepare()`` reuses its run_id.

    This is the whole point of the feature: the recorder recognizes its own
    armed session by the run_id the orchestrator hands back on start.
    """
    prepared = client.post(
        "/api/v1/record/prepare", json={"topics": ["/tf"], "compression": "none"}
    ).json()

    resp = client.post(
        "/api/v1/record/start", json={"topics": ["/tf"], "compression": "none"}
    )
    assert resp.status_code == 200
    run = resp.json()

    assert run["run_id"] == prepared["run_id"]
    assert run["state"] == "recording"
    # The recorder's /record/start received the SAME run_id it was armed with.
    assert fake_recorder.last_start_payload["run_id"] == prepared["run_id"]
    # The row is only created now, at start().
    assert store.get(prepared["run_id"]) is not None


def test_prepare_match_ignores_operator_task_differences(
    client: TestClient, fake_recorder: FakeRecorder
) -> None:
    """operator/task are session metadata, not part of the prepare/start match."""
    prepared = client.post(
        "/api/v1/record/prepare",
        json={"topics": ["/tf"], "operator": "alice", "task": "pickup"},
    ).json()

    resp = client.post(
        "/api/v1/record/start",
        json={"topics": ["/tf"], "operator": "bob", "task": "sort"},
    )
    run = resp.json()

    assert run["run_id"] == prepared["run_id"]
    assert run["operator"] == "bob"
    assert run["task"] == "sort"


def test_prepare_then_mismatched_start_falls_back_to_fresh_run_id(
    client: TestClient, fake_recorder: FakeRecorder, store: RunStore
) -> None:
    """A start() request that changed topics does NOT reuse the prepared id.

    Falls straight through to today's fresh-allocation path; the recorder is
    responsible for disarming its own now-stale armed session on its own.
    ``allocate_run_id`` is patched to two distinct values because prepare()
    and start() otherwise run within the same wall-clock second in a fast
    test and would legitimately compute the same timestamp-based id (which
    would make the id-equality assertion meaningless either way).
    """
    with patch(
        "api_orchestrator.runs.allocate_run_id",
        side_effect=["run_20260624_090000", "run_20260624_090001"],
    ):
        prepared = client.post(
            "/api/v1/record/prepare", json={"topics": ["/tf"]}
        ).json()
        resp = client.post("/api/v1/record/start", json={"topics": ["/joint_states"]})

    assert resp.status_code == 200
    run = resp.json()

    assert run["run_id"] != prepared["run_id"]
    assert run["run_id"] == "run_20260624_090001"
    assert run["state"] == "recording"
    assert fake_recorder.last_start_payload["run_id"] == run["run_id"]
    # The stale prepared run_id was never inserted as a row.
    assert store.get(prepared["run_id"]) is None


def test_prepare_then_start_with_different_compression_is_a_mismatch(
    client: TestClient, fake_recorder: FakeRecorder
) -> None:
    """Compression is part of the match key, same as topics."""
    with patch(
        "api_orchestrator.runs.allocate_run_id",
        side_effect=["run_20260624_090100", "run_20260624_090101"],
    ):
        prepared = client.post(
            "/api/v1/record/prepare",
            json={"topics": ["/tf"], "compression": "none"},
        ).json()
        resp = client.post(
            "/api/v1/record/start",
            json={"topics": ["/tf"], "compression": "zstd"},
        )
    run = resp.json()
    assert run["run_id"] != prepared["run_id"]


def test_prepared_run_id_collision_falls_back_to_fresh_allocation(
    client: TestClient, fake_recorder: FakeRecorder, store: RunStore
) -> None:
    """If the prepared run_id somehow got claimed first, start() recovers.

    Defensive edge case (shouldn't normally happen: a prepared run_id is never
    inserted until start() succeeds), exercised here by manually pre-seeding a
    row at the prepared id before calling start(). Must not surface a raw
    IntegrityError as a 500 -- fall back to fresh allocation, exactly like
    today's same-second collision retry.
    """
    prepared = client.post("/api/v1/record/prepare", json={"topics": ["/tf"]}).json()
    prepared_run_id = prepared["run_id"]

    store.create(Run(run_id=prepared_run_id, state=RunState.completed))

    resp = client.post("/api/v1/record/start", json={"topics": ["/tf"]})
    assert resp.status_code == 200
    run = resp.json()

    assert run["state"] == "recording"
    assert run["run_id"] != prepared_run_id
    assert fake_recorder.last_start_payload["run_id"] == run["run_id"]


def test_start_without_prior_prepare_is_unaffected(
    client: TestClient, app: FastAPI, fake_recorder: FakeRecorder
) -> None:
    """Regression: a start() with no prepare() behaves exactly as before.

    ``self._prepared`` stays ``None`` throughout -- the prepare-matching logic
    must be a complete no-op for any caller that never calls prepare first.
    """
    service: RunService = app.state.run_service
    assert service._prepared is None

    resp = client.post("/api/v1/record/start", json={"topics": ["/tf"]})

    assert resp.status_code == 200
    assert resp.json()["state"] == "recording"
    assert service._prepared is None
    assert fake_recorder.prepare_call_count == 0


def test_stop_disarms_prepared_session_when_never_started(
    client: TestClient, fake_recorder: FakeRecorder, store: RunStore
) -> None:
    """Cancelling right after prepare() (never start()) disarms the recorder.

    No run row exists to finalize, but the recorder is holding a live armed
    session (subscriptions established) that must not leak until its own
    auto-disarm timeout -- stop() is the cancel path for it.
    """
    prepared = client.post("/api/v1/record/prepare", json={"topics": ["/tf"]}).json()
    assert fake_recorder.stop_call_count == 0

    resp = client.post("/api/v1/record/stop")

    # Nothing has ever been recorded, so the existing idempotent-stop contract
    # (404, "no run has ever been recorded") is unchanged; the disarm call is
    # a side effect, not a new response shape.
    assert resp.status_code == 404
    assert fake_recorder.stop_call_count == 1
    assert store.get(prepared["run_id"]) is None


def test_stop_disarm_clears_prepared_so_it_is_not_reused(
    client: TestClient, fake_recorder: FakeRecorder, app: FastAPI
) -> None:
    """After a disarming stop(), a later matching start() does NOT reuse it."""
    with patch(
        "api_orchestrator.runs.allocate_run_id",
        side_effect=["run_20260624_090200", "run_20260624_090201"],
    ):
        prepared = client.post(
            "/api/v1/record/prepare", json={"topics": ["/tf"]}
        ).json()
        client.post("/api/v1/record/stop")

        service: RunService = app.state.run_service
        assert service._prepared is None

        resp = client.post("/api/v1/record/start", json={"topics": ["/tf"]})
    run = resp.json()
    assert run["run_id"] != prepared["run_id"]


def test_prepare_recorder_rejection_propagates_without_a_run_row(
    client: TestClient, fake_recorder: FakeRecorder, store: RunStore
) -> None:
    """Unlike start(), a recorder rejection on prepare has no row to degrade.

    There is nothing to mark ``failed`` (no row was ever created), so the
    recorder's error status/code propagates directly instead of a 200 with a
    failed run body.
    """
    fake_recorder.prepare_status = 409
    fake_recorder.prepare_error = {"code": "already_recording", "message": "busy"}

    resp = client.post("/api/v1/record/prepare", json={"topics": ["/tf"]})

    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "already_recording"
