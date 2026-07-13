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
    batch = _new_batch(client, robot="realman", target_episodes=10, operator="yuki")
    assert batch["robot"] == "realman"
    assert batch["target_episodes"] == 10
    assert batch["operator"] == "yuki"


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
        "index_in_batch": 2,
        "task_result": "failure",
        "failure_reason": "drop",
        "quality": "needs_review",
        "review_status": "pending",
    }

    detail = client.get(f"/api/v1/runs/{with_ep}").json()
    assert detail["episode"]["episode_id"] == ep_id


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
