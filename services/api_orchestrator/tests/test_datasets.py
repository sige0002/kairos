"""Dataset endpoints: list, export (MOVE + delete row), and bulk export-all.

The fake dora_runner performs a real ``dataset_export`` MOVE on disk (the same
contract the dora_runner service implements) so the orchestrator's
export -> delete-row -> datasets-list flow is exercised end to end, including
the key invariants: the recording leaves ``recorded/`` and the run row is
deleted ONLY after a confirmed successful export.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import httpx
from api_orchestrator.app_factory import create_orchestrator_app
from api_orchestrator.models import Run, RunState
from api_orchestrator.store import RunStore
from conftest import FakeRecorder
from fastapi.testclient import TestClient
from kairos_common import Settings


def _make_recorded_run(
    data_dir: Path, run_id: str, *, operator: str, task: str
) -> None:
    """Create a synthetic recorded run on disk (run dir + mcap + session.json)."""
    run_dir = data_dir / "recorded" / run_id
    run_dir.mkdir(parents=True)
    (run_dir / f"{run_id}_0.mcap").write_bytes(b"\x89MCAP0\r\n" + b"x" * 64)
    (run_dir / "session.json").write_text(
        json.dumps(
            {"run_id": run_id, "operator": operator, "task": task, "message_count": 9}
        ),
        encoding="utf-8",
    )


class FakeDoraExporter:
    """A dora_runner stand-in that MOVES a recorded run into the dataset tree.

    Mirrors the real ``dataset_export`` contract: ``POST /jobs`` performs the
    move synchronously and the job is reported ``succeeded`` with the export
    summary as its result. A run can be forced to fail via ``fail_run_ids``.
    """

    def __init__(self, data_dir: Path, *, fail_run_ids: set[str] | None = None) -> None:
        self._data_dir = data_dir
        self._fail = fail_run_ids or set()
        self._jobs: dict[str, dict] = {}
        self._n = 0

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/healthz":
            return httpx.Response(200, json={"status": "ok"})
        if path == "/jobs" and request.method == "POST":
            return self._create(request)
        if path.endswith("/status"):
            job_id = path.rsplit("/", 2)[1]
            return httpx.Response(200, json=self._jobs[job_id]["status"])
        if path.endswith("/result"):
            job_id = path.rsplit("/", 2)[1]
            return httpx.Response(200, json=self._jobs[job_id]["result"])
        return httpx.Response(404, json={"error": {"code": "nf", "message": path}})

    def _create(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        run_id = body["run_id"]
        self._n += 1
        job_id = f"job_{self._n}"
        if run_id in self._fail:
            self._jobs[job_id] = {
                "status": {
                    "job_id": job_id,
                    "run_id": run_id,
                    "pipeline": "dataset_export",
                    "state": "failed",
                    "progress": 1.0,
                    "logs_tail": [],
                },
                "result": {"summary": {"error": {"message": "boom"}}},
            }
            return httpx.Response(201, json={"job_id": job_id})
        summary = self._move(run_id)
        self._jobs[job_id] = {
            "status": {
                "job_id": job_id,
                "run_id": run_id,
                "pipeline": "dataset_export",
                "state": "succeeded",
                "progress": 1.0,
                "logs_tail": [],
            },
            "result": {"summary": summary, "artifacts": [summary["dataset_dir"]]},
        }
        return httpx.Response(201, json={"job_id": job_id})

    def _move(self, run_id: str) -> dict:
        """Perform the real MOVE (recorded/<run_id> -> <op>/<task>/NNN)."""
        run_dir = self._data_dir / "recorded" / run_id
        session = json.loads((run_dir / "session.json").read_text())
        operator = session["operator"]
        task = session["task"]
        parent = self._data_dir / operator / task
        parent.mkdir(parents=True, exist_ok=True)
        existing = [int(p.name) for p in parent.iterdir() if p.name.isdigit()]
        index = f"{(max(existing) + 1) if existing else 1:03d}"
        dataset_dir = parent / index
        dataset_dir.mkdir()
        files = []
        for child in sorted(run_dir.iterdir()):
            shutil.move(str(child), str(dataset_dir))
            files.append(child.name)
        run_dir.rmdir()
        summary = {
            "run_id": run_id,
            "operator": operator,
            "task": task,
            "index": index,
            "dataset_dir": str(dataset_dir),
            "files": files,
            "bytes": 72,
            "message_count": session.get("message_count"),
            "exported_at": "2026-06-26T00:00:00.000Z",
        }
        (dataset_dir / "dataset.json").write_text(json.dumps(summary), encoding="utf-8")
        report_dir = self._data_dir / "report" / "dataset_export" / run_id
        report_dir.mkdir(parents=True, exist_ok=True)
        (report_dir / "summary.json").write_text(json.dumps(summary), encoding="utf-8")
        return summary


def _build(
    tmp_path: Path,
    store: RunStore,
    fake_recorder: FakeRecorder,
    exporter: FakeDoraExporter,
) -> Settings:
    settings = Settings(
        recording_config="/nonexistent/recording.yaml",
        stream_config="/nonexistent/stream.yaml",
        data_dir=str(tmp_path / "data"),
        recorded_dir=str(tmp_path / "data" / "recorded"),
    )

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.port == settings.dora_runner_port:
            return exporter.handler(request)
        return fake_recorder.handler(request)

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    app = create_orchestrator_app(settings, store=store, http_client=http_client)
    return app


def test_export_moves_run_and_deletes_row(
    tmp_path: Path, store: RunStore, fake_recorder: FakeRecorder
) -> None:
    data_dir = tmp_path / "data"
    _make_recorded_run(data_dir, "run_a", operator="yuki", task="pick")
    store.create(Run(run_id="run_a", state=RunState.completed))
    exporter = FakeDoraExporter(data_dir)
    app = _build(tmp_path, store, fake_recorder, exporter)

    with TestClient(app) as client:
        resp = client.post("/api/v1/datasets/export", json={"run_id": "run_a"})
        assert resp.status_code == 200
        assert resp.json()["index"] == "001"
        assert resp.json()["dataset_dir"].endswith("/yuki/pick/001")

        # The row is GONE (run left the Recordings list) only after success.
        assert store.get("run_a") is None
        # The recording MOVED out of recorded/ and into the dataset tree.
        assert not (data_dir / "recorded" / "run_a").exists()
        assert (data_dir / "yuki" / "pick" / "001" / "run_a_0.mcap").exists()

        # It now appears under GET /datasets.
        datasets = client.get("/api/v1/datasets").json()["datasets"]
        assert len(datasets) == 1
        assert datasets[0]["operator"] == "yuki"
        assert datasets[0]["task"] == "pick"
        assert datasets[0]["index"] == "001"
        assert datasets[0]["run_id"] == "run_a"


def test_export_rejects_non_completed_run(
    tmp_path: Path, store: RunStore, fake_recorder: FakeRecorder
) -> None:
    data_dir = tmp_path / "data"
    _make_recorded_run(data_dir, "run_x", operator="yuki", task="pick")
    store.create(Run(run_id="run_x", state=RunState.failed))
    exporter = FakeDoraExporter(data_dir)
    app = _build(tmp_path, store, fake_recorder, exporter)

    with TestClient(app) as client:
        resp = client.post("/api/v1/datasets/export", json={"run_id": "run_x"})

    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "run_not_completed"
    # Untouched: still on disk, still in the store.
    assert (data_dir / "recorded" / "run_x").exists()
    assert store.get("run_x") is not None


def test_export_rejects_completed_run_without_files(
    tmp_path: Path, store: RunStore, fake_recorder: FakeRecorder
) -> None:
    """A completed run whose dir is gone (already exported) -> 409, row kept."""
    store.create(Run(run_id="run_gone", state=RunState.completed))
    exporter = FakeDoraExporter(tmp_path / "data")
    app = _build(tmp_path, store, fake_recorder, exporter)

    with TestClient(app) as client:
        resp = client.post("/api/v1/datasets/export", json={"run_id": "run_gone"})

    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "no_recorded_files"
    assert store.get("run_gone") is not None


def test_failed_export_keeps_row_and_files(
    tmp_path: Path, store: RunStore, fake_recorder: FakeRecorder
) -> None:
    """If the export job fails, the run stays in recorded/ and in the store."""
    data_dir = tmp_path / "data"
    _make_recorded_run(data_dir, "run_f", operator="yuki", task="pick")
    store.create(Run(run_id="run_f", state=RunState.completed))
    exporter = FakeDoraExporter(data_dir, fail_run_ids={"run_f"})
    app = _build(tmp_path, store, fake_recorder, exporter)

    with TestClient(app) as client:
        resp = client.post("/api/v1/datasets/export", json={"run_id": "run_f"})

    assert resp.status_code == 502
    assert resp.json()["error"]["code"] == "export_failed"
    # No data lost: the recording is intact and the row remains.
    assert (data_dir / "recorded" / "run_f").exists()
    assert store.get("run_f") is not None


def test_export_all_skips_failures_and_continues(
    tmp_path: Path, store: RunStore, fake_recorder: FakeRecorder
) -> None:
    data_dir = tmp_path / "data"
    for rid in ("run_1", "run_2", "run_3"):
        _make_recorded_run(data_dir, rid, operator="yuki", task="pick")
        store.create(Run(run_id=rid, state=RunState.completed))
    # A non-completed run and a completed-without-files run are NOT targeted.
    store.create(Run(run_id="run_live", state=RunState.recording))
    store.create(Run(run_id="run_nofiles", state=RunState.completed))
    fake_recorder.state = "recording"
    fake_recorder.run_id = "run_live"
    exporter = FakeDoraExporter(data_dir, fail_run_ids={"run_2"})
    app = _build(tmp_path, store, fake_recorder, exporter)

    with TestClient(app) as client:
        resp = client.post("/api/v1/datasets/export-all")
        body = resp.json()

        assert resp.status_code == 200
        # 3 completed-with-files targets; run_2 fails, the other two succeed.
        assert body["total"] == 3
        assert len(body["exported"]) == 2
        assert len(body["failed"]) == 1
        assert body["failed"][0]["run_id"] == "run_2"

        # Successful runs left the store + recorded/; the failed one stayed.
        assert store.get("run_1") is None
        assert store.get("run_3") is None
        assert store.get("run_2") is not None
        assert (data_dir / "recorded" / "run_2").exists()
        assert not (data_dir / "recorded" / "run_1").exists()

        # Two datasets are now browseable, both under yuki/pick.
        datasets = client.get("/api/v1/datasets").json()["datasets"]
        assert len(datasets) == 2
        assert {d["index"] for d in datasets} == {"001", "002"}


def test_list_datasets_empty(
    tmp_path: Path, store: RunStore, fake_recorder: FakeRecorder
) -> None:
    exporter = FakeDoraExporter(tmp_path / "data")
    app = _build(tmp_path, store, fake_recorder, exporter)
    with TestClient(app) as client:
        resp = client.get("/api/v1/datasets")
    assert resp.status_code == 200
    assert resp.json() == {"datasets": []}
