"""Batch & episode endpoints (Console v2 Phase 2).

Exercises the batch/episode CRUD, the run-list/detail episode join, and the
cascade that removes an episode when its run is deleted. Uses the shared
in-memory ``store`` + wired ``client`` fixtures from conftest.
"""

from __future__ import annotations

from api_orchestrator.models import Run, RunState
from api_orchestrator.store import RunStore
from fastapi.testclient import TestClient


def _seed_run(
    store: RunStore, run_id: str, state: RunState = RunState.completed
) -> str:
    """Insert a run directly (episodes reference an existing run)."""
    store.create(Run(run_id=run_id, state=state))
    return run_id


def _new_batch(client: TestClient, **overrides) -> dict:
    """Create a batch via the API and return the response body."""
    body = {"project": "proj", "task": "pick", "condition": "cond_a", **overrides}
    resp = client.post("/api/v1/batches", json=body)
    assert resp.status_code == 201, resp.text
    return resp.json()


# ---- batches --------------------------------------------------------------


def test_create_batch_defaults_robot_and_target(client: TestClient) -> None:
    batch = _new_batch(client)
    assert batch["batch_id"].startswith("batch_")
    assert batch["robot"] == "airoa_hsr"  # active robot fallback
    assert batch["target_episodes"] == 30
    assert batch["status"] == "active"
    assert batch["created_at"] is not None
    assert batch["ended_at"] is None


def test_create_batch_accepts_explicit_robot_and_target(client: TestClient) -> None:
    batch = _new_batch(client, robot="myrobot", target_episodes=10, operator="yuki")
    assert batch["robot"] == "myrobot"
    assert batch["target_episodes"] == 10
    assert batch["operator"] == "yuki"


def test_batch_seq_allocated_and_increments_same_day(client: TestClient) -> None:
    """The server assigns batch_seq per (robot, local day): consecutive batches
    for the same robot increment; a different robot restarts at 1."""
    first = _new_batch(client)
    second = _new_batch(client)
    assert first["batch_seq"] == 1
    assert second["batch_seq"] == 2  # same (default) robot, same local day
    other = _new_batch(client, robot="myrobot")
    assert other["batch_seq"] == 1  # different robot -> restarts at 1


def test_get_batch_returns_full_batch_with_episodes(client: TestClient) -> None:
    batch_id = _new_batch(client)["batch_id"]
    resp = client.get(f"/api/v1/batches/{batch_id}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["batch_id"] == batch_id
    assert body["episode_count"] == 0
    assert body["episodes"] == []


def test_get_missing_batch_is_404(client: TestClient) -> None:
    resp = client.get("/api/v1/batches/batch_nope")
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "batch_not_found"


def test_patch_batch_early_stop_sets_ended_at(client: TestClient) -> None:
    batch_id = _new_batch(client)["batch_id"]
    resp = client.patch(
        f"/api/v1/batches/{batch_id}",
        json={"status": "ended_early", "ended_reason": "safety"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ended_early"
    assert body["ended_reason"] == "safety"
    assert body["ended_at"] is not None


def test_patch_batch_condition_change(client: TestClient) -> None:
    batch_id = _new_batch(client)["batch_id"]
    body = client.patch(
        f"/api/v1/batches/{batch_id}", json={"condition": "cond_b"}
    ).json()
    assert body["condition"] == "cond_b"
    assert body["status"] == "active"  # unchanged
    assert body["ended_at"] is None  # non-terminal patch doesn't stamp end


def test_patch_batch_project_task_relabel(client: TestClient) -> None:
    # An empty batch the operator re-labels before its first recording: the
    # project/task/condition patch reaches the batch row so later episodes don't
    # drift from the operator's choice in index.jsonl.
    batch_id = _new_batch(client, project="proj", task="pick", condition="cond_a")[
        "batch_id"
    ]
    body = client.patch(
        f"/api/v1/batches/{batch_id}",
        json={"project": "proj2", "task": "place", "condition": "cond_b"},
    ).json()
    assert body["project"] == "proj2"
    assert body["task"] == "place"
    assert body["condition"] == "cond_b"
    assert body["status"] == "active"  # non-terminal patch
    assert body["ended_at"] is None


def test_patch_batch_task_only_leaves_project_and_condition(client: TestClient) -> None:
    # A free-text (custom) task sends only `task`; omitted fields keep their value.
    batch_id = _new_batch(client, project="proj", task="pick", condition="cond_a")[
        "batch_id"
    ]
    body = client.patch(f"/api/v1/batches/{batch_id}", json={"task": "handover"}).json()
    assert body["task"] == "handover"
    assert body["project"] == "proj"  # unchanged
    assert body["condition"] == "cond_a"  # unchanged (omitted → kept)


def test_patch_missing_batch_is_404(client: TestClient) -> None:
    resp = client.patch("/api/v1/batches/batch_nope", json={"status": "completed"})
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "batch_not_found"


def test_list_batches_newest_first_and_status_filter(client: TestClient) -> None:
    first = _new_batch(client, project="p1")["batch_id"]
    second = _new_batch(client, project="p2")["batch_id"]
    client.patch(f"/api/v1/batches/{first}", json={"status": "completed"})

    items = client.get("/api/v1/batches").json()["items"]
    assert [b["batch_id"] for b in items] == [second, first]  # newest first

    active = client.get("/api/v1/batches?status=active").json()["items"]
    assert [b["batch_id"] for b in active] == [second]


# ---- episodes -------------------------------------------------------------


def test_create_episode_and_batch_summary(client: TestClient, store: RunStore) -> None:
    batch_id = _new_batch(client)["batch_id"]
    run_id = _seed_run(store, "run_20260101_000000")
    resp = client.post(
        "/api/v1/episodes",
        json={
            "batch_id": batch_id,
            "run_id": run_id,
            "index_in_batch": 1,
            "task_result": "success",
            "quality": "good",
        },
    )
    assert resp.status_code == 201, resp.text
    ep = resp.json()
    assert ep["episode_id"].startswith("ep_")
    assert ep["quality_source"] == "operator"
    assert ep["review_status"] == "pending"

    # The batch list now reports the episode count + compact summary.
    listed = client.get("/api/v1/batches").json()["items"][0]
    assert listed["episode_count"] == 1
    assert listed["episodes"][0] == {
        "index": 1,
        "run_id": run_id,
        "batch_seq": 1,  # first batch of the local day for this robot
        "task_result": "success",
        "quality": "good",
        "review_status": "pending",
    }


def test_create_episode_unknown_batch_is_404(
    client: TestClient, store: RunStore
) -> None:
    run_id = _seed_run(store, "run_a")
    resp = client.post(
        "/api/v1/episodes",
        json={
            "batch_id": "batch_nope",
            "run_id": run_id,
            "index_in_batch": 0,
            "task_result": "success",
            "quality": "good",
        },
    )
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "batch_not_found"


def test_create_episode_unknown_run_is_404(client: TestClient) -> None:
    batch_id = _new_batch(client)["batch_id"]
    resp = client.post(
        "/api/v1/episodes",
        json={
            "batch_id": batch_id,
            "run_id": "run_nope",
            "index_in_batch": 0,
            "task_result": "success",
            "quality": "good",
        },
    )
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "run_not_found"


def test_create_episode_duplicate_run_is_409(
    client: TestClient, store: RunStore
) -> None:
    batch_id = _new_batch(client)["batch_id"]
    run_id = _seed_run(store, "run_dup")
    payload = {
        "batch_id": batch_id,
        "run_id": run_id,
        "index_in_batch": 0,
        "task_result": "failure",
        "failure_reason": "slip",
        "quality": "not_usable",
    }
    assert client.post("/api/v1/episodes", json=payload).status_code == 201
    resp = client.post("/api/v1/episodes", json=payload)
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "episode_exists"


def test_patch_episode_adopt_and_override(client: TestClient, store: RunStore) -> None:
    batch_id = _new_batch(client)["batch_id"]
    run_id = _seed_run(store, "run_patch")
    ep_id = client.post(
        "/api/v1/episodes",
        json={
            "batch_id": batch_id,
            "run_id": run_id,
            "index_in_batch": 0,
            "task_result": "success",
            "quality": "needs_review",
        },
    ).json()["episode_id"]

    resp = client.patch(
        f"/api/v1/episodes/{ep_id}",
        json={"review_status": "adopted", "quality": "good"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["review_status"] == "adopted"
    assert body["quality"] == "good"
    assert body["updated_at"] is not None


def test_patch_missing_episode_is_404(client: TestClient) -> None:
    resp = client.patch("/api/v1/episodes/ep_nope", json={"review_status": "excluded"})
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "episode_not_found"


# ---- runs join + cascade --------------------------------------------------


def test_runs_list_and_detail_attach_episode(
    client: TestClient, store: RunStore
) -> None:
    batch_id = _new_batch(client)["batch_id"]
    with_ep = _seed_run(store, "run_with_ep")
    without_ep = _seed_run(store, "run_without_ep")
    ep_id = client.post(
        "/api/v1/episodes",
        json={
            "batch_id": batch_id,
            "run_id": with_ep,
            "index_in_batch": 2,
            "task_result": "failure",
            "failure_reason": "drop",
            "quality": "needs_review",
        },
    ).json()["episode_id"]

    items = {r["run_id"]: r for r in client.get("/api/v1/runs").json()["items"]}
    assert items[without_ep]["episode"] is None
    joined = items[with_ep]["episode"]
    assert joined == {
        "episode_id": ep_id,
        "batch_id": batch_id,
        "batch_seq": 1,  # the join carries the batch's per-day number
        "index_in_batch": 2,
        "task_result": "failure",
        "failure_reason": "drop",
        "quality": "needs_review",
        "review_status": "pending",
    }

    detail = client.get(f"/api/v1/runs/{with_ep}").json()
    assert detail["episode"]["episode_id"] == ep_id
    assert detail["episode"]["batch_seq"] == 1


def test_delete_run_cascades_episode(client: TestClient, store: RunStore) -> None:
    batch_id = _new_batch(client)["batch_id"]
    run_id = _seed_run(store, "run_cascade")
    client.post(
        "/api/v1/episodes",
        json={
            "batch_id": batch_id,
            "run_id": run_id,
            "index_in_batch": 0,
            "task_result": "success",
            "quality": "good",
        },
    )
    assert store.get_episode_by_run_id(run_id) is not None

    assert client.delete(f"/api/v1/runs/{run_id}").status_code == 204
    assert store.get_episode_by_run_id(run_id) is None
    # The batch still exists, now with no episodes.
    assert client.get(f"/api/v1/batches/{batch_id}").json()["episode_count"] == 0


def test_episodes_recorded_is_monotone_across_a_run_delete(
    client: TestClient, store: RunStore
) -> None:
    """The recorded counter counts what was captured and never shrinks on a
    delete — the fix for Collect's episode count dropping after a Review delete.
    """
    batch_id = _new_batch(client)["batch_id"]
    for i in range(1, 4):
        run_id = _seed_run(store, f"run_rec_{i}")
        assert (
            client.post(
                "/api/v1/episodes",
                json={
                    "batch_id": batch_id,
                    "run_id": run_id,
                    "index_in_batch": i,
                    "task_result": "success",
                    "quality": "good",
                },
            ).status_code
            == 201
        )

    batch = client.get(f"/api/v1/batches/{batch_id}").json()
    assert batch["episode_count"] == 3
    assert batch["episodes_recorded"] == 3

    # Delete one run → its episode cascades away, so the live count drops to 2 …
    assert client.delete("/api/v1/runs/run_rec_2").status_code == 204
    batch = client.get(f"/api/v1/batches/{batch_id}").json()
    assert batch["episode_count"] == 2
    # … but the monotone recorded count stays 3 (3 episodes were captured).
    assert batch["episodes_recorded"] == 3
    # Surfaced in the active-batch list (Collect's restore path) too.
    active = client.get("/api/v1/batches", params={"status": "active"}).json()
    assert active["items"][0]["episodes_recorded"] == 3


def test_episode_index_collision_reallocates_server_side(
    client: TestClient, store: RunStore
) -> None:
    """Two terminals saving the same browser-allocated index into one batch:
    the second insert must NOT collide silently — the server re-allocates the
    next free index and returns it (persona review R2 / codex adjacent-5)."""
    batch_id = _new_batch(client)["batch_id"]
    run_a = _seed_run(store, "run_20260714_000010")
    run_b = _seed_run(store, "run_20260714_000011")

    body = {
        "batch_id": batch_id,
        "run_id": run_a,
        "index_in_batch": 1,
        "task_result": "success",
        "quality": "good",
    }
    first = client.post("/api/v1/episodes", json=body)
    assert first.status_code == 201
    assert first.json()["index_in_batch"] == 1

    second = client.post("/api/v1/episodes", json={**body, "run_id": run_b})
    assert second.status_code == 201
    # Server-side re-allocation: the stored index is the batch max + 1.
    assert second.json()["index_in_batch"] == 2

    # Both rows persisted, indices unique within the batch.
    eps = client.get(f"/api/v1/batches/{batch_id}").json()["episodes"]
    assert sorted(e["index_in_batch"] for e in eps) == [1, 2]


def test_list_batches_robot_and_operator_filters(client: TestClient) -> None:
    """Collect scopes its active-batch restore by robot/operator so one
    terminal never adopts another robot's or operator's batch."""
    _new_batch(client, robot="airoa_hsr", operator="alice")
    _new_batch(client, robot="myrobot", operator="bob")

    by_robot = client.get("/api/v1/batches", params={"robot": "myrobot"}).json()
    assert [b["robot"] for b in by_robot["items"]] == ["myrobot"]

    by_op = client.get("/api/v1/batches", params={"operator": "alice"}).json()
    assert [b["operator"] for b in by_op["items"]] == ["alice"]

    both = client.get(
        "/api/v1/batches", params={"robot": "airoa_hsr", "operator": "bob"}
    ).json()
    assert both["items"] == []


def test_patch_batch_target_episodes(client: TestClient) -> None:
    """Mid-batch plan-size change (Collect's Change target…), validated 1-500."""
    batch = _new_batch(client)
    resp = client.patch(
        f"/api/v1/batches/{batch['batch_id']}", json={"target_episodes": 10}
    )
    assert resp.status_code == 200
    assert resp.json()["target_episodes"] == 10
    # Out-of-range targets are rejected by validation, not silently clamped.
    assert (
        client.patch(
            f"/api/v1/batches/{batch['batch_id']}", json={"target_episodes": 0}
        ).status_code
        == 422
    )
    assert (
        client.patch(
            f"/api/v1/batches/{batch['batch_id']}", json={"target_episodes": 501}
        ).status_code
        == 422
    )


# ---- auto-pull on Save (cross-host split) ----------------------------------


class _FakeImporter:
    """Spy stand-in for the importer sidecar client."""

    def __init__(self) -> None:
        self.calls: list[str] = []

    async def pull(self, run_id: str) -> dict:
        self.calls.append(run_id)
        return {"queued": True, "run_id": run_id}


def _save_episode(client: TestClient, store: RunStore, run_id: str) -> None:
    """Seed a run and save an episode for it (the Collect Save path)."""
    _seed_run(store, run_id)
    batch_id = _new_batch(client)["batch_id"]
    resp = client.post(
        "/api/v1/episodes",
        json={
            "batch_id": batch_id,
            "run_id": run_id,
            "index_in_batch": 1,
            "task_result": "success",
        },
    )
    assert resp.status_code == 201, resp.text


def test_save_triggers_importer_pull_when_opted_in(
    client: TestClient, store: RunStore
) -> None:
    """With transfer.auto_pull_on_save=true a Save fires one importer pull for
    the saved run (fire-and-forget: the 201 must not wait on the importer)."""
    import time

    from kairos_common.recording_config import RecordingConfig, TransferConfig

    fake = _FakeImporter()
    client.app.state.importer_client = fake
    client.app.state.recording_config = RecordingConfig(
        robot_name="r", transfer=TransferConfig(auto_pull_on_save=True)
    )
    _save_episode(client, store, "run_pull_me")
    # The pull is a background task on the app loop; give it a beat to land.
    for _ in range(200):
        if fake.calls:
            break
        time.sleep(0.01)
    assert fake.calls == ["run_pull_me"]


def test_save_does_not_pull_by_default(client: TestClient, store: RunStore) -> None:
    """Default config (auto_pull_on_save=false — or no config at all, as here)
    must NEVER transfer anything on its own."""
    import time

    fake = _FakeImporter()
    client.app.state.importer_client = fake
    _save_episode(client, store, "run_stay_put")
    time.sleep(0.05)  # would-be task window
    assert fake.calls == []


def test_save_survives_importer_failure(client: TestClient, store: RunStore) -> None:
    """An unreachable importer must not fail or delay the Save (fire-and-forget
    logs the error; sweep / manual import-runs are the recovery paths)."""
    import time

    from kairos_common import ApiError
    from kairos_common.recording_config import RecordingConfig, TransferConfig

    class _DownImporter:
        async def pull(self, run_id: str) -> dict:
            raise ApiError(
                status_code=503,
                code="importer_unreachable",
                message="down",
            )

    client.app.state.importer_client = _DownImporter()
    client.app.state.recording_config = RecordingConfig(
        robot_name="r", transfer=TransferConfig(auto_pull_on_save=True)
    )
    _save_episode(client, store, "run_importer_down")  # asserts the 201
    time.sleep(0.05)  # let the background task run its error path
