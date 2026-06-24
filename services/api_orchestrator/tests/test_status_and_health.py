"""Status proxy, readyz components, and startup reconciliation."""

from __future__ import annotations

import httpx
from api_orchestrator.app_factory import create_orchestrator_app
from api_orchestrator.models import Run, RunState
from api_orchestrator.store import RunStore
from conftest import FakeRecorder
from fastapi.testclient import TestClient
from kairos_common import Settings


def test_status_proxies_recorder(
    client: TestClient, fake_recorder: FakeRecorder
) -> None:
    """``GET /record/status`` returns the recorder's status verbatim."""
    client.post("/api/v1/record/start", json={"topics": ["/tf"]})
    resp = client.get("/api/v1/record/status")
    assert resp.status_code == 200
    body = resp.json()
    assert body["state"] == "recording"
    assert body["run_id"] == fake_recorder.run_id


def test_readyz_reports_recorder_ok(client: TestClient) -> None:
    resp = client.get("/readyz")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ready"
    assert body["components"]["recorder"] == "ok"


def test_readyz_reports_recorder_unreachable(
    client: TestClient, fake_recorder: FakeRecorder
) -> None:
    fake_recorder.healthz_ok = False
    resp = client.get("/readyz")
    assert resp.status_code == 200  # readiness reports state, not an HTTP error
    body = resp.json()
    assert body["status"] == "degraded"
    assert body["components"]["recorder"] == "unreachable"


def test_status_surfaces_recorder_unreachable_as_503(
    settings: Settings, store: RunStore
) -> None:
    """When the recorder transport fails, the status proxy returns a 503."""

    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(boom))
    app = create_orchestrator_app(settings, store=store, http_client=http_client)
    with TestClient(app) as client:
        resp = client.get("/api/v1/record/status")
    assert resp.status_code == 503
    assert resp.json()["error"]["code"] == "recorder_unreachable"


def test_startup_reconciliation_interrupts_orphans(
    settings: Settings, store: RunStore, fake_recorder: FakeRecorder
) -> None:
    """A run left ``recording`` with an idle recorder becomes ``interrupted``."""
    # Simulate a crash: a recording run persists, but the recorder is idle.
    store.create(Run(run_id="run_20260101_000000", state=RunState.recording))
    assert fake_recorder.state == "idle"

    http_client = httpx.AsyncClient(
        transport=httpx.MockTransport(fake_recorder.handler)
    )
    app = create_orchestrator_app(settings, store=store, http_client=http_client)
    with TestClient(app):  # entering lifespan runs reconciliation
        pass

    assert store.get("run_20260101_000000").state.value == "interrupted"


def test_reconciliation_keeps_genuinely_active_run(
    settings: Settings, store: RunStore, fake_recorder: FakeRecorder
) -> None:
    """A recording run whose id matches the active recorder session is kept."""
    fake_recorder.state = "recording"
    fake_recorder.run_id = "run_20260101_000000"
    store.create(Run(run_id="run_20260101_000000", state=RunState.recording))

    http_client = httpx.AsyncClient(
        transport=httpx.MockTransport(fake_recorder.handler)
    )
    app = create_orchestrator_app(settings, store=store, http_client=http_client)
    with TestClient(app):
        pass

    assert store.get("run_20260101_000000").state.value == "recording"
