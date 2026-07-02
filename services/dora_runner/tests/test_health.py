"""Service smoke tests."""

from __future__ import annotations

import dora_runner.main as main
from fastapi.testclient import TestClient

client = TestClient(main.app)


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


def test_readyz_reports_dora_in_process(monkeypatch) -> None:
    """Without the dora CLI, the service is still ready (DORA-M2)."""
    monkeypatch.setattr(main, "dora_cli_available", lambda: False)
    resp = client.get("/readyz")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ready"
    assert body["components"]["dora"] == "in-process"


def test_readyz_reports_dora_available(monkeypatch) -> None:
    monkeypatch.setattr(main, "dora_cli_available", lambda: True)
    resp = client.get("/readyz")
    assert resp.status_code == 200
    assert resp.json()["components"]["dora"] == "available"
