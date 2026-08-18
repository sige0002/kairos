# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Service smoke tests."""

from __future__ import annotations

import dora_runner.main as main
from dora_runner.main import create_dora_app
from dora_runner.store import RunnerStore
from fastapi.testclient import TestClient

# The app is no longer built at module import; construct one with an in-memory
# store so this smoke test has no filesystem side effect.
client = TestClient(create_dora_app(store=RunnerStore(":memory:")))


def test_healthz() -> None:
    resp = client.get("/healthz")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_root_reports_service() -> None:
    resp = client.get("/")
    assert resp.status_code == 200
    assert resp.json() == {"service": "dora_runner"}


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
