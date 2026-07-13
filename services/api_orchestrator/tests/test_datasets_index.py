"""Root dataset catalog (``data/index.jsonl``): append/delete/serve/rebuild.

The catalog is a derived, rebuildable optimization over the exported-dataset
tree; the sidecars stay canonical. These tests pin: export appends a row, the
list serves from the catalog with a byte-identical shape to the tree scan,
delete rewrites it, an absent/corrupt catalog transparently falls back to a
scan, and rebuild regenerates it purely from the on-disk sidecars.
"""

from __future__ import annotations

import json
from pathlib import Path

from api_orchestrator import datasets_index
from api_orchestrator.models import Run, RunState
from api_orchestrator.routers.datasets import _scan_datasets
from api_orchestrator.store import RunStore
from conftest import FakeRecorder
from fastapi.testclient import TestClient
from test_datasets import (
    FakeDoraExporter,
    _build,
    _make_recorded_run,
    _seed_batch_episode,
)


def _index_lines(data_dir: Path) -> list[dict]:
    text = (data_dir / "index.jsonl").read_text(encoding="utf-8")
    return [json.loads(ln) for ln in text.splitlines() if ln.strip()]


# ---- unit: row conversions + read resilience -------------------------------


def test_index_row_derives_components_and_relative_path(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    dataset_dir = data_dir / "yuki" / "pick" / "001"
    row = datasets_index.index_row(
        dataset_dir,
        {"run_id": "r1", "bytes": 5, "message_count": 9, "exported_at": "t"},
        {
            "task_result": "success",
            "quality": "good",
            "review_status": "pending",
            "batch_seq": 2,
            "index_in_batch": 3,
        },
        data_dir,
    )
    assert row["operator"] == "yuki"
    assert row["task"] == "pick"
    assert row["index"] == "001"
    assert row["dataset_dir"] == "yuki/pick/001"  # relative, portable
    assert row["schema_version"] == 1
    assert row["batch_seq"] == 2
    # Round-trips back to the absolute list shape.
    listed = datasets_index.to_list_row(row, data_dir)
    assert listed["dataset_dir"] == str(dataset_dir)
    assert "schema_version" not in listed


def test_read_rows_absent_and_corrupt_signal_fallback(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    assert datasets_index.read_rows(data_dir) is None  # absent
    (data_dir / "index.jsonl").write_text("not json\n", encoding="utf-8")
    assert datasets_index.read_rows(data_dir) is None  # corrupt
    (data_dir / "index.jsonl").write_text("", encoding="utf-8")
    assert datasets_index.read_rows(data_dir) == []  # empty is a valid catalog


# ---- endpoint: append on export + list served from the catalog -------------


def test_export_appends_row_and_list_matches_scan(
    tmp_path: Path, store: RunStore, fake_recorder: FakeRecorder
) -> None:
    data_dir = tmp_path / "data"
    _make_recorded_run(data_dir, "run_a", operator="yuki", task="pick")
    store.create(Run(run_id="run_a", state=RunState.completed))
    _seed_batch_episode(store, run_id="run_a", batch_id="b", ep_id="e")
    app = _build(tmp_path, store, fake_recorder, FakeDoraExporter(data_dir))

    with TestClient(app) as client:
        assert (
            client.post("/api/v1/datasets/export", json={"run_id": "run_a"}).status_code
            == 200
        )

        # A catalog row was appended (relative path, episode subset).
        rows = _index_lines(data_dir)
        assert len(rows) == 1
        assert rows[0]["dataset_dir"] == "yuki/pick/001"
        assert rows[0]["run_id"] == "run_a"
        assert rows[0]["task_result"] == "failure"
        assert rows[0]["batch_seq"] == 1
        assert rows[0]["schema_version"] == 1

        # The list is served from the catalog and is byte-identical to a scan.
        served = client.get("/api/v1/datasets").json()["datasets"]
        assert served == _scan_datasets(data_dir)


def test_delete_dataset_rewrites_catalog(
    tmp_path: Path, store: RunStore, fake_recorder: FakeRecorder
) -> None:
    data_dir = tmp_path / "data"
    for rid in ("run_1", "run_2"):
        _make_recorded_run(data_dir, rid, operator="yuki", task="pick")
        store.create(Run(run_id=rid, state=RunState.completed))
    app = _build(tmp_path, store, fake_recorder, FakeDoraExporter(data_dir))

    with TestClient(app) as client:
        assert client.post("/api/v1/datasets/export-all").status_code == 200
        assert len(_index_lines(data_dir)) == 2

        assert client.delete("/api/v1/datasets/yuki/pick/001").status_code == 204
        rows = _index_lines(data_dir)
        assert [r["index"] for r in rows] == ["002"]
        # Served list agrees.
        served = client.get("/api/v1/datasets").json()["datasets"]
        assert [d["index"] for d in served] == ["002"]


def test_list_falls_back_to_scan_without_catalog(
    tmp_path: Path, store: RunStore, fake_recorder: FakeRecorder
) -> None:
    data_dir = tmp_path / "data"
    # A dataset on disk but no index.jsonl (e.g. imported tree) -> scan fallback.
    dataset_dir = data_dir / "yuki" / "pick" / "001"
    dataset_dir.mkdir(parents=True)
    (dataset_dir / "dataset.json").write_text(
        json.dumps({"run_id": "r", "bytes": 1}), encoding="utf-8"
    )
    app = _build(tmp_path, store, fake_recorder, FakeDoraExporter(data_dir))
    with TestClient(app) as client:
        served = client.get("/api/v1/datasets").json()["datasets"]
    assert [d["index"] for d in served] == ["001"]
    assert not (data_dir / "index.jsonl").exists()  # scan did not create one


def test_list_falls_back_when_catalog_corrupt(
    tmp_path: Path, store: RunStore, fake_recorder: FakeRecorder
) -> None:
    data_dir = tmp_path / "data"
    dataset_dir = data_dir / "yuki" / "pick" / "001"
    dataset_dir.mkdir(parents=True)
    (dataset_dir / "dataset.json").write_text(
        json.dumps({"run_id": "r"}), encoding="utf-8"
    )
    (data_dir / "index.jsonl").write_text("{ broken\n", encoding="utf-8")
    app = _build(tmp_path, store, fake_recorder, FakeDoraExporter(data_dir))
    with TestClient(app) as client:
        served = client.get("/api/v1/datasets").json()["datasets"]
    assert [d["index"] for d in served] == ["001"]  # fell back despite the catalog


def test_rebuild_regenerates_from_sidecars(
    tmp_path: Path, store: RunStore, fake_recorder: FakeRecorder
) -> None:
    data_dir = tmp_path / "data"
    _make_recorded_run(data_dir, "run_a", operator="yuki", task="pick")
    store.create(Run(run_id="run_a", state=RunState.completed))
    _seed_batch_episode(store, run_id="run_a", batch_id="b", ep_id="e")
    app = _build(tmp_path, store, fake_recorder, FakeDoraExporter(data_dir))

    with TestClient(app) as client:
        assert (
            client.post("/api/v1/datasets/export", json={"run_id": "run_a"}).status_code
            == 200
        )
        # Corrupt the catalog, then rebuild it from the on-disk sidecars.
        (data_dir / "index.jsonl").write_text("garbage\n", encoding="utf-8")
        resp = client.post("/api/v1/datasets/index/rebuild")
        assert resp.status_code == 200
        assert resp.json() == {"count": 1}

        rows = _index_lines(data_dir)
        assert len(rows) == 1
        assert rows[0]["dataset_dir"] == "yuki/pick/001"
        assert rows[0]["task_result"] == "failure"  # from episode.json sidecar
        # And the list now serves from the rebuilt catalog, identical to a scan.
        assert client.get("/api/v1/datasets").json()["datasets"] == _scan_datasets(
            data_dir
        )
