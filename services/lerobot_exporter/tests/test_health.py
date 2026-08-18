# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Service smoke tests."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient
from kairos_common import Settings
from lerobot_exporter.main import create_exporter_app


def _client(data_dir: Path) -> TestClient:
    return TestClient(create_exporter_app(Settings(data_dir=str(data_dir))))


def test_healthz_is_the_liveness_path(data_dir: Path) -> None:
    """What the orchestrator's client and the compose healthcheck both probe."""
    assert _client(data_dir).get("/healthz").json() == {"status": "ok"}


def test_readyz_answers(data_dir: Path) -> None:
    """No dependency of its own to check: the converter is only ever a child."""
    assert _client(data_dir).get("/readyz").json() == {"status": "ready"}


def test_root_reports_service(data_dir: Path) -> None:
    assert _client(data_dir).get("/").json() == {"service": "lerobot_exporter"}


def test_unknown_export_is_404(data_dir: Path) -> None:
    response = _client(data_dir).get("/exports/nope")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "export_not_found"
