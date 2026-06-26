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


def _detail_service(store: RunStore, tmp_path) -> RunService:
    """A RunService whose recorded/data roots point at *tmp_path* (no recorder
    calls happen in get_detail, so a never-used mock transport is fine)."""
    import httpx
    from api_orchestrator.recorder_client import RecorderClient

    http_client = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _req: httpx.Response(404))
    )
    return RunService(
        store,
        RecorderClient("http://recorder", http_client),
        None,
        recorded_dir=tmp_path / "recorded",
        data_dir=tmp_path,
    )


def test_get_detail_reads_manifest_and_report_sidecars(
    store: RunStore, tmp_path
) -> None:
    import json

    run_dir = tmp_path / "recorded" / "run_x"
    run_dir.mkdir(parents=True)
    (run_dir / "manifest.json").write_text(
        json.dumps({"state": "completed", "error": None}), encoding="utf-8"
    )
    val = tmp_path / "report" / "fast_validation" / "run_x"
    val.mkdir(parents=True)
    (val / "summary.json").write_text(json.dumps({"result": "pass"}), encoding="utf-8")
    ds = tmp_path / "report" / "dataset_export" / "run_x"
    ds.mkdir(parents=True)
    (ds / "summary.json").write_text(
        json.dumps({"index": "001", "dataset_dir": "/data/yuki/pick/001"}),
        encoding="utf-8",
    )
    loss = tmp_path / "report" / "loss_report" / "run_x"
    loss.mkdir(parents=True)
    (loss / "summary.json").write_text(
        json.dumps({"run_id": "run_x", "topics": [{"name": "/tf", "loss_rate": 0.0}]}),
        encoding="utf-8",
    )
    store.create(Run(run_id="run_x", state=RunState.completed))

    detail = _detail_service(store, tmp_path).get_detail("run_x")

    assert detail.manifest is not None and detail.manifest["state"] == "completed"
    assert detail.validation is not None and detail.validation["result"] == "pass"
    assert detail.dataset_stats is not None and detail.dataset_stats["index"] == "001"
    assert detail.loss is not None and detail.loss["topics"][0]["name"] == "/tf"


def test_get_detail_missing_sidecars_are_null(store: RunStore, tmp_path) -> None:
    store.create(Run(run_id="run_y", state=RunState.completed))
    detail = _detail_service(store, tmp_path).get_detail("run_y")
    assert detail.manifest is None
    assert detail.validation is None
    assert detail.dataset_stats is None
    assert detail.loss is None


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
