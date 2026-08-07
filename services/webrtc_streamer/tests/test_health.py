"""Smoke test: the service starts and answers /healthz (no ROS required)."""

from __future__ import annotations

from fastapi.testclient import TestClient
from webrtc_streamer.main import app

client = TestClient(app)


def test_healthz() -> None:
    resp = client.get("/healthz")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_root_reports_service() -> None:
    resp = client.get("/")
    assert resp.status_code == 200
    assert resp.json() == {"service": "webrtc_streamer"}
