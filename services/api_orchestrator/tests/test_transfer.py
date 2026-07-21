"""Transfer endpoints (``/api/v1/transfer``) + the runs ``bag_local`` field.

The UI-triggered pull path for the cross-host split: ``GET /status`` is the
frontend's split-mode signal (importer reachable = transfer channel exists),
``POST /pull`` proxies to the importer sidecar, and completion is observed via
``bag_local`` on the runs list (``metadata.yaml`` present locally = fully
imported, per import_runs.sh's "metadata.yaml lands last" contract).
"""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest
from api_orchestrator.app_factory import create_orchestrator_app
from api_orchestrator.models import Run, RunState
from api_orchestrator.store import RunStore
from fastapi.testclient import TestClient
from kairos_common import ApiError, Settings


class _FakeImporter:
    """Spy stand-in for the importer sidecar client (reachable)."""

    def __init__(self) -> None:
        self.calls: list[str | None] = []

    async def healthz(self) -> bool:
        return True

    async def pull(self, run_id: str | None = None) -> dict:
        self.calls.append(run_id)
        return {"queued": True, "run_id": run_id}


class _DownImporter:
    """Importer client whose peer is unreachable (single-host deploy)."""

    async def healthz(self) -> bool:
        return False

    async def pull(self, run_id: str | None = None) -> dict:
        raise ApiError(
            status_code=503,
            code="importer_unreachable",
            message="The importer service is unreachable.",
        )


# ---- GET /status -----------------------------------------------------------


def test_status_available_when_importer_up(client: TestClient) -> None:
    """Importer reachable -> available=true; default config -> auto-pull off."""
    client.app.state.importer_client = _FakeImporter()
    body = client.get("/api/v1/transfer/status").json()
    assert body == {"available": True, "auto_pull_on_save": False}


def test_status_unavailable_when_importer_down(client: TestClient) -> None:
    """Single-host deploy (no importer container) -> available=false, 200 OK."""
    client.app.state.importer_client = _DownImporter()
    body = client.get("/api/v1/transfer/status").json()
    assert body == {"available": False, "auto_pull_on_save": False}


def test_status_reports_auto_pull_opt_in(client: TestClient) -> None:
    from kairos_common.recording_config import RecordingConfig, TransferConfig

    client.app.state.importer_client = _FakeImporter()
    client.app.state.recording_config = RecordingConfig(
        robot_name="r", transfer=TransferConfig(auto_pull_on_save=True)
    )
    assert client.get("/api/v1/transfer/status").json()["auto_pull_on_save"] is True


# ---- POST /pull ------------------------------------------------------------


def test_pull_single_run_proxies_to_importer(client: TestClient) -> None:
    fake = _FakeImporter()
    client.app.state.importer_client = fake
    resp = client.post("/api/v1/transfer/pull", json={"run_id": "run_a"})
    assert resp.status_code == 202
    assert resp.json()["run_id"] == "run_a"
    assert fake.calls == ["run_a"]


def test_pull_all_finalised_with_empty_body(client: TestClient) -> None:
    fake = _FakeImporter()
    client.app.state.importer_client = fake
    resp = client.post("/api/v1/transfer/pull", json={})
    assert resp.status_code == 202
    assert resp.json()["run_id"] is None
    assert fake.calls == [None]


def test_pull_importer_down_is_503(client: TestClient) -> None:
    """The single-host answer to a stray pull: an honest unified 503."""
    client.app.state.importer_client = _DownImporter()
    resp = client.post("/api/v1/transfer/pull", json={"run_id": "run_a"})
    assert resp.status_code == 503
    assert resp.json()["error"]["code"] == "importer_unreachable"


# ---- bag_local on the runs read paths --------------------------------------


@pytest.fixture
def local_client(tmp_path: Path, store: RunStore, fake_recorder) -> TestClient:
    """A wired app whose recorded_dir is a tmp dir the test can populate."""
    settings = Settings(
        recording_config="/nonexistent/recording.yaml",
        stream_config="/nonexistent/stream.yaml",
        recorded_dir=str(tmp_path),
    )
    http = httpx.AsyncClient(transport=httpx.MockTransport(fake_recorder.handler))
    app = create_orchestrator_app(settings, store=store, http_client=http)
    with TestClient(app) as test_client:
        yield test_client


def test_bag_local_tracks_metadata_yaml(
    local_client: TestClient, store: RunStore, tmp_path: Path
) -> None:
    """bag_local is true iff recorded/<run_id>/metadata.yaml exists locally —
    a bare run dir (partial rsync in flight) must NOT count as transferred."""
    store.create(Run(run_id="run_here", state=RunState.completed))
    store.create(Run(run_id="run_partial", state=RunState.completed))
    store.create(Run(run_id="run_on_robot", state=RunState.completed))
    (tmp_path / "run_here").mkdir()
    (tmp_path / "run_here" / "metadata.yaml").write_text("rosbag2_bagfile_information:")
    (tmp_path / "run_partial").mkdir()  # dir exists, no metadata.yaml yet

    items = local_client.get("/api/v1/runs").json()["items"]
    by_id = {r["run_id"]: r for r in items}
    assert by_id["run_here"]["bag_local"] is True
    assert by_id["run_partial"]["bag_local"] is False
    assert by_id["run_on_robot"]["bag_local"] is False

    # The single-run detail path reports the same signal (the transfer poll).
    assert local_client.get("/api/v1/runs/run_here").json()["bag_local"] is True
    assert local_client.get("/api/v1/runs/run_on_robot").json()["bag_local"] is False
