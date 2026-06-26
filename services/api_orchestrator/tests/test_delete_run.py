"""DELETE /api/v1/runs/{id}: removes the recording dir + the run row.

The recorder relaxes its run dirs to 0o777 so the orchestrator (uid 1000) can
remove them; here the recorded root is a tmp dir we populate directly.
"""

from __future__ import annotations

from pathlib import Path

import httpx
from api_orchestrator.app_factory import create_orchestrator_app
from api_orchestrator.store import RunStore
from fastapi.testclient import TestClient
from kairos_common import Settings


def _client(tmp_path: Path, fake_recorder, store: RunStore) -> TestClient:
    settings = Settings(
        recording_config="/nonexistent/recording.yaml",
        recorded_dir=str(tmp_path),
    )
    http_client = httpx.AsyncClient(
        transport=httpx.MockTransport(fake_recorder.handler)
    )
    app = create_orchestrator_app(settings, store=store, http_client=http_client)
    return TestClient(app)


def test_delete_removes_dir_and_row(tmp_path: Path, fake_recorder, store: RunStore):
    with _client(tmp_path, fake_recorder, store) as client:
        run_id = client.post("/api/v1/record/start", json={"topics": "all"}).json()[
            "run_id"
        ]
        client.post("/api/v1/record/stop")
        # Simulate the on-disk recording dir the recorder would have written.
        run_dir = tmp_path / run_id
        run_dir.mkdir(parents=True)
        (run_dir / f"{run_id}_0.mcap").write_bytes(b"\x00")
        (run_dir / "session.json").write_text("{}")

        resp = client.delete(f"/api/v1/runs/{run_id}")
        assert resp.status_code == 204
        assert not run_dir.exists()  # directory removed
        assert client.get(f"/api/v1/runs/{run_id}").status_code == 404  # row gone


def test_delete_removes_siblings_and_reports_but_keeps_dataset(
    tmp_path: Path, fake_recorder, store: RunStore
):
    """BUG-B: delete also removes the recorder's sibling files and this run's
    post-hoc report sidecars — but NOT an intentionally-exported dataset."""
    settings = Settings(
        recording_config="/nonexistent/recording.yaml",
        data_dir=str(tmp_path),
        recorded_dir=str(tmp_path / "recorded"),
    )
    http_client = httpx.AsyncClient(
        transport=httpx.MockTransport(fake_recorder.handler)
    )
    app = create_orchestrator_app(settings, store=store, http_client=http_client)
    with TestClient(app) as client:
        run_id = client.post("/api/v1/record/start", json={"topics": "all"}).json()[
            "run_id"
        ]
        client.post("/api/v1/record/stop")
        recorded = tmp_path / "recorded"
        run_dir = recorded / run_id
        run_dir.mkdir(parents=True)
        (run_dir / f"{run_id}_0.mcap").write_bytes(b"\x00")
        # Recorder siblings + a report sidecar for this run.
        (recorded / f"{run_id}.qos.yaml").write_text("x")
        (recorded / f"{run_id}.failed.json").write_text("{}")
        report = tmp_path / "report" / "loss_report" / run_id
        report.mkdir(parents=True)
        (report / "summary.json").write_text("{}")
        # An exported dataset — an intentional artifact that must survive.
        dataset = tmp_path / "yuki" / "pick" / "001"
        dataset.mkdir(parents=True)
        (dataset / f"{run_id}_0.mcap").write_bytes(b"\x00")

        assert client.delete(f"/api/v1/runs/{run_id}").status_code == 204

        assert not run_dir.exists()
        assert not (recorded / f"{run_id}.qos.yaml").exists()
        assert not (recorded / f"{run_id}.failed.json").exists()
        assert not report.exists()
        # The exported dataset is deliberately NOT removed.
        assert (dataset / f"{run_id}_0.mcap").exists()


def test_delete_unknown_is_404(tmp_path: Path, fake_recorder, store: RunStore):
    with _client(tmp_path, fake_recorder, store) as client:
        assert client.delete("/api/v1/runs/run_nope").status_code == 404


def test_delete_active_is_409(tmp_path: Path, fake_recorder, store: RunStore):
    with _client(tmp_path, fake_recorder, store) as client:
        run_id = client.post("/api/v1/record/start", json={"topics": "all"}).json()[
            "run_id"
        ]
        # Still recording (no stop) -> refused.
        resp = client.delete(f"/api/v1/runs/{run_id}")
        assert resp.status_code == 409
        assert client.get(f"/api/v1/runs/{run_id}").status_code == 200  # kept
