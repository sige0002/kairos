"""Config tab catalog: list/select validation + inject the active template.

Selecting a validation template applies immediately — a template-less
fast_validation job created afterwards carries the newly-active template.
"""

from __future__ import annotations

import json
from pathlib import Path

import httpx
from api_orchestrator.app_factory import create_orchestrator_app
from api_orchestrator.store import RunStore
from fastapi.testclient import TestClient
from kairos_common import Settings


def _write_template(dir_: Path, stem: str, name: str, topic: str) -> None:
    dir_.mkdir(parents=True, exist_ok=True)
    (dir_ / f"{stem}.yaml").write_text(
        f"name: {name}\nversion: 1\nrequired_topics:\n  - {{ name: {topic} }}\n",
        encoding="utf-8",
    )


class _FakeDora:
    """Records the create_job payload; returns a succeeded job."""

    def __init__(self) -> None:
        self.last_payload: dict | None = None

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/healthz":
            return httpx.Response(200, json={"status": "ok"})
        if path == "/jobs" and request.method == "POST":
            self.last_payload = json.loads(request.content)
            return httpx.Response(201, json={"job_id": "job_1"})
        if path == "/jobs/job_1/status":
            return httpx.Response(
                200,
                json={
                    "job_id": "job_1",
                    "run_id": "run_a",
                    "pipeline": "fast_validation",
                    "state": "succeeded",
                    "progress": 1.0,
                    "logs_tail": [],
                },
            )
        return httpx.Response(404, json={"error": {"code": "nf", "message": path}})


def _client(tmp_path: Path, fake_recorder, dora: _FakeDora) -> TestClient:
    vdir = tmp_path / "validation"
    _write_template(vdir, "alpha", "alpha_template", "/alpha")
    _write_template(vdir, "beta", "beta_template", "/beta")
    settings = Settings(
        recording_config="/nonexistent/recording.yaml",
        validation_dir=str(vdir),
        validation_default="alpha",
    )

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.port == settings.dora_runner_port:
            return dora.handler(request)
        return fake_recorder.handler(request)

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    app = create_orchestrator_app(
        settings, store=RunStore(":memory:"), http_client=http_client
    )
    return TestClient(app)


def test_config_tab_is_enabled(client) -> None:
    tabs = [t["id"] for t in client.get("/api/v1/config").json()["tabs"]]
    assert "config" in tabs


def test_options_list_and_select(tmp_path: Path, fake_recorder) -> None:
    test_client = _client(tmp_path, fake_recorder, _FakeDora())
    with test_client as c:
        opts = c.get("/api/v1/config/options").json()["validation"]
        assert opts["active"] == "alpha"
        assert {o["id"] for o in opts["options"]} == {"alpha", "beta"}

        # Select beta -> active updates.
        after = c.post(
            "/api/v1/config/select", json={"category": "validation", "id": "beta"}
        ).json()
        assert after["validation"]["active"] == "beta"

        # Unknown id -> 404; unknown category -> 400.
        assert (
            c.post(
                "/api/v1/config/select", json={"category": "validation", "id": "nope"}
            ).status_code
            == 404
        )
        assert (
            c.post(
                "/api/v1/config/select", json={"category": "robot", "id": "alpha"}
            ).status_code
            == 400
        )


def test_active_validation_injected_into_jobs(tmp_path: Path, fake_recorder) -> None:
    dora = _FakeDora()
    test_client = _client(tmp_path, fake_recorder, dora)
    with test_client as c:
        # Template-less fast_validation job -> active (alpha) is injected.
        c.post(
            "/api/v1/jobs",
            json={"run_id": "run_a", "pipeline": "fast_validation", "params": {}},
        )
        assert dora.last_payload is not None
        assert dora.last_payload["params"]["template"]["name"] == "alpha_template"

        # After selecting beta, a new job carries beta.
        c.post(
            "/api/v1/config/select", json={"category": "validation", "id": "beta"}
        )
        c.post(
            "/api/v1/jobs",
            json={"run_id": "run_a", "pipeline": "fast_validation", "params": {}},
        )
        assert dora.last_payload["params"]["template"]["name"] == "beta_template"


def test_explicit_template_is_not_overridden(tmp_path: Path, fake_recorder) -> None:
    dora = _FakeDora()
    test_client = _client(tmp_path, fake_recorder, dora)
    with test_client as c:
        explicit = {"name": "mine", "version": 1, "required_topics": []}
        c.post(
            "/api/v1/jobs",
            json={
                "run_id": "run_a",
                "pipeline": "fast_validation",
                "params": {"template": explicit},
            },
        )
        assert dora.last_payload["params"]["template"]["name"] == "mine"
