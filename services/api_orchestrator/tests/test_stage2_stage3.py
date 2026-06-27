"""Stage-2 wiring and Stage-3 orchestrator route tests."""

from __future__ import annotations

import httpx
from api_orchestrator.app_factory import create_orchestrator_app
from api_orchestrator.store import RunStore
from conftest import FakeRecorder
from fastapi.testclient import TestClient
from kairos_common import Settings


class FakeDoraRunner:
    """Small dora_runner stand-in for orchestrator proxy tests."""

    def __init__(self) -> None:
        self.job_id = "job_test"

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/healthz":
            return httpx.Response(200, json={"status": "ok"})
        if path == "/pipelines":
            return httpx.Response(
                200,
                json={
                    "items": [
                        {
                            "id": "fast_validation",
                            "name": "Fast validation",
                            "description": "Required-topic check.",
                            "enabled": True,
                            "schema": {"type": "object"},
                        }
                    ]
                },
            )
        if path == "/jobs" and request.method == "POST":
            return httpx.Response(201, json={"job_id": self.job_id})
        if path == f"/jobs/{self.job_id}/status":
            return httpx.Response(
                200,
                json={
                    "job_id": self.job_id,
                    "run_id": "run_a",
                    "pipeline": "fast_validation",
                    "state": "succeeded",
                    "progress": 1.0,
                    "logs_tail": ["done"],
                },
            )
        if path == f"/jobs/{self.job_id}/result":
            return httpx.Response(
                200,
                json={"summary": {"result": "pass"}, "artifacts": ["summary.json"]},
            )
        if path == f"/jobs/{self.job_id}/cancel" and request.method == "POST":
            return self.handler(
                httpx.Request("GET", f"http://localhost:8020/jobs/{self.job_id}/status")
            )
        if path == "/validation/templates" and request.method == "POST":
            return httpx.Response(201, content=request.content)
        if path == "/validation/templates/generate":
            return httpx.Response(
                200,
                json={
                    "name": "draft",
                    "version": 1,
                    "required_topics": [
                        {"name": "/tf", "type": "tf2_msgs/msg/TFMessage"}
                    ],
                },
            )
        return httpx.Response(
            404, json={"error": {"code": "not_found", "message": path}}
        )


def test_stage2_topics_and_readyz_are_wired(
    settings: Settings, store: RunStore, fake_recorder: FakeRecorder
) -> None:
    """Monitor and streamer clients are constructed and reported in readyz."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.port == settings.topic_monitor_port:
            if request.url.path == "/healthz":
                return httpx.Response(200, json={"status": "ok"})
            if request.url.path == "/topics":
                return httpx.Response(200, json={"items": [{"name": "/tf"}]})
            if request.url.path == "/metrics":
                return httpx.Response(200, json={"items": []})
        if request.url.port == settings.webrtc_port and request.url.path == "/healthz":
            return httpx.Response(503, json={"status": "down"})
        return fake_recorder.handler(request)

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    app = create_orchestrator_app(settings, store=store, http_client=http_client)
    with TestClient(app) as client:
        topics = client.get("/api/v1/topics")
        ready = client.get("/readyz")

    assert topics.status_code == 200
    assert topics.json()["items"][0]["name"] == "/tf"
    assert ready.json()["status"] == "degraded"
    assert ready.json()["components"] == {
        "recorder": "ok",
        "monitor": "ok",
        "streamer": "unreachable",
    }


def test_jobs_and_validation_routes_proxy_and_persist(
    settings: Settings, store: RunStore, fake_recorder: FakeRecorder
) -> None:
    fake_dora = FakeDoraRunner()

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.port == settings.dora_runner_port:
            return fake_dora.handler(request)
        return fake_recorder.handler(request)

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    app = create_orchestrator_app(settings, store=store, http_client=http_client)
    with TestClient(app) as client:
        pipelines = client.get("/api/v1/pipelines")
        created = client.post(
            "/api/v1/jobs",
            json={"run_id": "run_a", "pipeline": "fast_validation", "params": {}},
        )
        status = client.get("/api/v1/jobs/job_test/status")
        result = client.get("/api/v1/jobs/job_test/result")
        template = client.post(
            "/api/v1/validation/templates",
            json={"name": "base", "version": 1, "required_topics": [{"name": "/tf"}]},
        )
        generated = client.post(
            "/api/v1/validation/templates/generate", json={"run_id": "run_a"}
        )

    assert pipelines.status_code == 200
    assert pipelines.json()["items"][0]["id"] == "fast_validation"
    assert created.status_code == 201
    assert created.json()["state"] == "succeeded"
    assert status.json()["progress"] == 1.0
    assert result.json()["summary"]["result"] == "pass"
    assert template.status_code == 201
    assert generated.json()["name"] == "draft"
    assert store.get_job("job_test") is not None


def test_fast_validation_resolves_template_id_to_full_object(
    store: RunStore, fake_recorder: FakeRecorder, tmp_path
) -> None:
    """The UI sends a template *id* (file stem); the orchestrator must inject the
    full template object before forwarding, because dora_runner's template store
    starts empty and would 404 on a bare id (regression: validation always failed).
    """
    # Robot-first tree: the active robot's validation dir holds the template id.
    root = tmp_path / "config"
    vdir = root / "myrobot" / "validation"
    vdir.mkdir(parents=True)
    (vdir / "myrobot.yaml").write_text(
        "name: myrobot\nversion: 3\n"
        "required_topics:\n  - {name: /scan, type: sensor_msgs/msg/LaserScan}\n",
        encoding="utf-8",
    )
    settings = Settings(
        recording_config="/nonexistent/recording.yaml",
        stream_config="/nonexistent/stream.yaml",
        config_dir=str(root),
        config_local_dir=str(root / "local"),
        robot="myrobot",
    )

    fake_dora = FakeDoraRunner()
    forwarded: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.port == settings.dora_runner_port:
            if request.url.path == "/jobs" and request.method == "POST":
                import json as _json

                forwarded.update(_json.loads(request.content))
            return fake_dora.handler(request)
        return fake_recorder.handler(request)

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    app = create_orchestrator_app(settings, store=store, http_client=http_client)
    with TestClient(app) as client:
        created = client.post(
            "/api/v1/jobs",
            json={
                "run_id": "run_a",
                "pipeline": "fast_validation",
                "params": {"template": "myrobot"},
            },
        )

    assert created.status_code == 201
    tmpl = forwarded["params"]["template"]
    # Resolved to the full object, not the bare id string.
    assert isinstance(tmpl, dict)
    assert tmpl["name"] == "myrobot"
    assert tmpl["version"] == 3
    assert tmpl["required_topics"][0]["name"] == "/scan"


def test_dataset_export_rejected_for_unfinished_run(
    settings: Settings, store: RunStore, fake_recorder: FakeRecorder
) -> None:
    """A dataset_export job must be refused while the run is still recording
    (would copy a bag mid-write); only a 404/409 — never forwarded to dora."""
    from api_orchestrator.models import Run, RunState

    store.create(Run(run_id="run_live", state=RunState.recording))
    # Make the recorder genuinely report this active session so startup
    # reconciliation leaves the row `recording` (an idle recorder would flip it
    # to interrupted, which is terminal and exportable).
    fake_recorder.state = "recording"
    fake_recorder.run_id = "run_live"
    fake_dora = FakeDoraRunner()

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.port == settings.dora_runner_port:
            return fake_dora.handler(request)
        return fake_recorder.handler(request)

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    app = create_orchestrator_app(settings, store=store, http_client=http_client)
    with TestClient(app) as client:
        # Recording run -> 409.
        active = client.post(
            "/api/v1/jobs",
            json={"run_id": "run_live", "pipeline": "dataset_export", "params": {}},
        )
        # Unknown run -> 404.
        missing = client.post(
            "/api/v1/jobs",
            json={"run_id": "run_ghost", "pipeline": "dataset_export", "params": {}},
        )

    assert active.status_code == 409
    assert active.json()["error"]["code"] == "run_not_finished"
    assert missing.status_code == 404
