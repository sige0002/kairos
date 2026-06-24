"""Smoke tests: health endpoints, root, and the render-gate config stub.

Uses the wired app fixture (in-memory store + fake recorder) so importing the
service does not touch ``/data``.
"""

from __future__ import annotations

from fastapi.testclient import TestClient


def test_healthz(client: TestClient) -> None:
    resp = client.get("/healthz")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_root_reports_stage1(client: TestClient) -> None:
    resp = client.get("/")
    assert resp.status_code == 200
    body = resp.json()
    assert body["service"] == "api_orchestrator"
    assert body["stage"] == "stage1"


def test_runtime_config_shape(client: TestClient) -> None:
    """The render-gate config must expose endpoints + the documented tabs."""
    resp = client.get("/api/v1/config")
    assert resp.status_code == 200
    body = resp.json()
    assert set(body) >= {"endpoints", "tabs", "defaults", "schemas"}
    tab_ids = [t["id"] for t in body["tabs"]]
    assert tab_ids == ["record", "monitor", "stream", "runs", "pipelines"]
    pipelines = next(t for t in body["tabs"] if t["id"] == "pipelines")
    assert pipelines["enabled"] is True
    assert "fast_validation" in body["schemas"]["pipeline_forms"]
