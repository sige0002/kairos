"""Service smoke tests."""

from __future__ import annotations

from dora_runner.main import app
from fastapi.testclient import TestClient

client = TestClient(app)


def test_healthz() -> None:
    resp = client.get("/healthz")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_root_reports_stage3() -> None:
    resp = client.get("/")
    assert resp.status_code == 200
    body = resp.json()
    assert body["service"] == "dora_runner"
    assert body["stage"] == "stage3"


def test_readyz_reports_dora_component() -> None:
    resp = client.get("/readyz")
    assert resp.status_code == 200
    assert resp.json()["components"]["dora"] == "ok"
