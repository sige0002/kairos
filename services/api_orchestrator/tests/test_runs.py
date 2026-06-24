"""Run query endpoints: pagination and single-run lookup."""

from __future__ import annotations

import pytest
from api_orchestrator.models import Run, RunState
from api_orchestrator.runs import RunService
from api_orchestrator.store import RunStore
from fastapi import FastAPI
from fastapi.testclient import TestClient
from kairos_common import ApiError


def _seed(store: RunStore, count: int) -> list[str]:
    """Insert *count* runs and return their ids in insertion order."""
    ids = []
    for i in range(count):
        run_id = f"run_2026010{i}_000000"
        store.create(Run(run_id=run_id, state=RunState.completed))
        ids.append(run_id)
    return ids


def test_list_runs_is_newest_first(client: TestClient, store: RunStore) -> None:
    ids = _seed(store, 3)
    resp = client.get("/api/v1/runs")
    assert resp.status_code == 200
    body = resp.json()
    assert body["next_cursor"] is None
    returned = [r["run_id"] for r in body["items"]]
    assert returned == list(reversed(ids))


def test_list_runs_pagination_walks_all_pages(
    client: TestClient, store: RunStore
) -> None:
    ids = _seed(store, 5)
    seen: list[str] = []
    cursor: str | None = None
    for _ in range(10):  # safety bound
        url = f"/api/v1/runs?limit=2{f'&cursor={cursor}' if cursor else ''}"
        body = client.get(url).json()
        seen.extend(r["run_id"] for r in body["items"])
        cursor = body["next_cursor"]
        if cursor is None:
            break

    assert cursor is None
    # Every run appears exactly once, newest first, no duplicates.
    assert seen == list(reversed(ids))
    assert len(seen) == len(set(seen)) == 5


def test_list_runs_limit_bounds(client: TestClient, store: RunStore) -> None:
    _seed(store, 3)
    # limit below 1 and above max are rejected by query validation (422).
    assert client.get("/api/v1/runs?limit=0").status_code == 422
    assert client.get("/api/v1/runs?limit=99999").status_code == 422


def test_invalid_cursor_is_400(client: TestClient, store: RunStore) -> None:
    _seed(store, 1)
    resp = client.get("/api/v1/runs?cursor=not-an-int")
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "invalid_cursor"


def test_get_run_returns_full_shape(client: TestClient) -> None:
    """A run created via the API is retrievable with the documented fields."""
    created = client.post("/api/v1/record/start", json={"topics": ["/tf"]}).json()
    resp = client.get(f"/api/v1/runs/{created['run_id']}")
    assert resp.status_code == 200
    run = resp.json()
    assert set(run) >= {
        "run_id",
        "state",
        "started_at",
        "ended_at",
        "topics",
        "compression",
        "split",
        "error",
    }


def test_get_missing_run_is_404(client: TestClient) -> None:
    resp = client.get("/api/v1/runs/run_20990101_000000")
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "run_not_found"


def test_update_missing_run_maps_to_404(app: FastAPI) -> None:
    """Updating a non-existent run yields a unified 404, not a bare 500.

    The store raises ``KeyError`` for a missing row; the service must translate
    it into an :class:`ApiError` so it renders in the ``{error:{...}}`` envelope.
    """
    service: RunService = app.state.run_service
    with pytest.raises(ApiError) as exc_info:
        service._update("run_does_not_exist", state=RunState.completed)

    assert exc_info.value.status_code == 404
    assert exc_info.value.code == "run_not_found"
    assert exc_info.value.details == {"run_id": "run_does_not_exist"}
