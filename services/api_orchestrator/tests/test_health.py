# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Smoke tests: health endpoints, root, and the render-gate config endpoint.

Uses the wired app fixture (in-memory store + fake recorder) so importing the
service does not touch ``/data``.
"""

from __future__ import annotations

from pathlib import Path

import httpx
from api_orchestrator.app_factory import create_orchestrator_app
from fastapi.testclient import TestClient
from kairos_common import Settings


def test_healthz(client: TestClient) -> None:
    resp = client.get("/healthz")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_root_reports_service(client: TestClient) -> None:
    resp = client.get("/")
    assert resp.status_code == 200
    assert resp.json() == {"service": "api_orchestrator"}


def test_runtime_config_shape(client: TestClient) -> None:
    """The render-gate config must expose endpoints + the documented tabs."""
    resp = client.get("/api/v1/config")
    assert resp.status_code == 200
    body = resp.json()
    assert set(body) >= {"endpoints", "tabs", "defaults", "schemas"}
    # The v1 tab registry is retired: an empty legacy key, never a dead list.
    assert body["tabs"] == []
    assert "fast_validation" in body["schemas"]["pipeline_forms"]
    # default_topics is always present (empty when no RECORDING_CONFIG is loaded)
    # so the Record/Monitor tabs can rely on its shape.
    assert body["defaults"]["default_topics"] == []
    # stream is always present (single empty pane when no STREAM_CONFIG).
    assert body["stream"] == {"columns": 2, "panes": []}


def test_runtime_config_surfaces_stream_config(tmp_path: Path, fake_recorder) -> None:
    """With a STREAM_CONFIG loaded, GET /config exposes its columns + panes so
    the Stream tab opens the configured previews."""
    cfg = tmp_path / "stream.yaml"
    cfg.write_text(
        "columns: 3\n"
        "panes:\n"
        "  - topic: /cam/head/compressed\n"
        "  - topic: /cam/hand/compressed\n",
        encoding="utf-8",
    )
    settings = Settings(
        data_dir=str(tmp_path / "data"),
        recording_config="/nonexistent/recording.yaml",
        stream_config=str(cfg),
    )
    http_client = httpx.AsyncClient(
        transport=httpx.MockTransport(fake_recorder.handler)
    )
    app = create_orchestrator_app(settings, http_client=http_client)
    with TestClient(app) as client:
        stream = client.get("/api/v1/config").json()["stream"]

    assert stream["columns"] == 3
    assert [p["topic"] for p in stream["panes"]] == [
        "/cam/head/compressed",
        "/cam/hand/compressed",
    ]


def test_runtime_config_surfaces_recording_config(
    tmp_path: Path, fake_recorder
) -> None:
    """With a RECORDING_CONFIG loaded, GET /config exposes its default_topics,
    expected_hz patterns (those with a fixed Hz), and robot_name so the UI can
    pre-select recording topics without the operator typing them by hand."""
    cfg = tmp_path / "recording.yaml"
    cfg.write_text(
        "robot_name: hsr\n"
        "default_topics:\n"
        "  - /hsrb/joint_states\n"
        "  - /hsrb/wrist_wrench/raw\n"
        "expected_hz_patterns:\n"
        "  - pattern: '**/compressed'\n"
        "    hz: 30\n"
        "  - pattern: /hsrb/joint_states\n"
        "    hz: 50\n"
        "  - pattern: /learned\n"  # no hz -> dynamically learned -> omitted
        "\n",
        encoding="utf-8",
    )
    settings = Settings(data_dir=str(tmp_path / "data"), recording_config=str(cfg))
    http_client = httpx.AsyncClient(
        transport=httpx.MockTransport(fake_recorder.handler)
    )
    app = create_orchestrator_app(settings, http_client=http_client)
    with TestClient(app) as client:
        defaults = client.get("/api/v1/config").json()["defaults"]

    assert defaults["robot_name"] == "hsr"
    assert defaults["default_topics"] == [
        "/hsrb/joint_states",
        "/hsrb/wrist_wrench/raw",
    ]
    # Only patterns with a fixed hz are surfaced; learned (null) ones are skipped.
    assert defaults["expected_hz"] == {"**/compressed": 30, "/hsrb/joint_states": 50}
