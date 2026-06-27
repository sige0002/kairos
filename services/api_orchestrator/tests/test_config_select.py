"""Config tab catalog: robot -> aspect -> option listing/selection + apply.

Robot-first config tree: ``config/<robot>/<aspect>/*.yaml`` (committed) and
``config/local/<robot>/...`` (gitignored). Selecting a robot re-points the live
recording + stream configs; selecting an aspect option switches that aspect. The
active robot's active validation template is injected into template-less
``fast_validation`` jobs.
"""

from __future__ import annotations

import json
from pathlib import Path

import httpx
from api_orchestrator.app_factory import create_orchestrator_app
from api_orchestrator.store import RunStore
from fastapi.testclient import TestClient
from kairos_common import Settings


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _build_tree(root: Path) -> None:
    """Two committed robots (alpha, bravo) + one gitignored local robot (charlie)."""
    # alpha — full set, with a second recording + validation option to select.
    _write(
        root / "alpha/recording/default.yaml",
        "robot_name: alpha\ndefault_topics: [/a, /b]\n",
    )
    _write(
        root / "alpha/recording/minimal.yaml",
        "robot_name: alpha\ndefault_topics: [/a]\n",
    )
    _write(root / "alpha/stream/default.yaml", "columns: 2\npanes: [{topic: /cam}]\n")
    _write(
        root / "alpha/validation/default.yaml",
        "name: alpha_default\nversion: 1\nrequired_topics:\n  - { name: /a }\n",
    )
    _write(
        root / "alpha/validation/strict.yaml",
        "name: alpha_strict\nversion: 2\n"
        "required_topics:\n  - { name: /a }\n  - { name: /b }\n",
    )
    _write(
        root / "alpha/validators/loss_report.yaml", "gap_threshold_multiplier: 5.0\n"
    )
    # bravo — different topics + a 1-column stream.
    _write(
        root / "bravo/recording/default.yaml",
        "robot_name: bravo\ndefault_topics: [/x]\n",
    )
    _write(root / "bravo/stream/default.yaml", "columns: 1\npanes: []\n")
    _write(
        root / "bravo/validation/default.yaml",
        "name: bravo_default\nversion: 1\nrequired_topics:\n  - { name: /x }\n",
    )
    # charlie — gitignored local robot, recording only (no stream/validation).
    _write(
        root / "local/charlie/recording/default.yaml",
        "robot_name: charlie\ndefault_topics: [/c]\n",
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
    root = tmp_path / "config"
    _build_tree(root)
    settings = Settings(
        config_dir=str(root),
        config_local_dir=str(root / "local"),
        robot="alpha",
        recording_config=str(root / "alpha/recording/default.yaml"),
        stream_config=str(root / "alpha/stream/default.yaml"),
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


def test_options_are_robot_first(tmp_path: Path, fake_recorder) -> None:
    with _client(tmp_path, fake_recorder, _FakeDora()) as c:
        body = c.get("/api/v1/config/options").json()
        assert body["active_robot"] == "alpha"
        robots = {r["id"]: r["local"] for r in body["robots"]}
        assert robots == {"alpha": False, "bravo": False, "charlie": True}
        # Aspect options are scoped to the active robot (alpha).
        rec = body["aspects"]["recording"]
        assert rec["active"] == "default"
        assert {o["id"] for o in rec["options"]} == {"default", "minimal"}
        assert {o["id"] for o in body["aspects"]["validation"]["options"]} == {
            "default",
            "strict",
        }


def test_select_aspect_option_switches_and_applies(
    tmp_path: Path, fake_recorder
) -> None:
    with _client(tmp_path, fake_recorder, _FakeDora()) as c:
        # Switch the recording option -> active changes AND GET /config reflects it.
        after = c.post(
            "/api/v1/config/select", json={"category": "recording", "id": "minimal"}
        ).json()
        assert after["aspects"]["recording"]["active"] == "minimal"
        defaults = c.get("/api/v1/config").json()["defaults"]
        assert defaults["default_topics"] == ["/a"]
        # Validation switch is reflected too.
        after = c.post(
            "/api/v1/config/select", json={"category": "validation", "id": "strict"}
        ).json()
        assert after["aspects"]["validation"]["active"] == "strict"


def test_select_robot_repoints_recording_and_stream(
    tmp_path: Path, fake_recorder
) -> None:
    with _client(tmp_path, fake_recorder, _FakeDora()) as c:
        after = c.post(
            "/api/v1/config/select", json={"category": "robot", "id": "bravo"}
        ).json()
        assert after["active_robot"] == "bravo"
        # Aspects re-scope to bravo (recording has only `default`).
        assert {o["id"] for o in after["aspects"]["recording"]["options"]} == {
            "default"
        }
        cfg = c.get("/api/v1/config").json()
        assert cfg["defaults"]["default_topics"] == ["/x"]
        assert cfg["stream"]["columns"] == 1  # bravo's stream applied live


def test_select_local_robot(tmp_path: Path, fake_recorder) -> None:
    with _client(tmp_path, fake_recorder, _FakeDora()) as c:
        c.post("/api/v1/config/select", json={"category": "robot", "id": "charlie"})
        cfg = c.get("/api/v1/config").json()
        assert cfg["defaults"]["default_topics"] == ["/c"]
        # charlie has no stream option -> falls back to the empty layout.
        assert cfg["stream"] == {"columns": 2, "panes": []}


def test_select_bad_input(tmp_path: Path, fake_recorder) -> None:
    with _client(tmp_path, fake_recorder, _FakeDora()) as c:
        assert (
            c.post(
                "/api/v1/config/select", json={"category": "recording", "id": "nope"}
            ).status_code
            == 404
        )
        assert (
            c.post(
                "/api/v1/config/select", json={"category": "robot", "id": "nope"}
            ).status_code
            == 404
        )
        assert (
            c.post(
                "/api/v1/config/select", json={"category": "bogus", "id": "default"}
            ).status_code
            == 400
        )


def test_active_validation_injected_into_jobs(tmp_path: Path, fake_recorder) -> None:
    dora = _FakeDora()
    with _client(tmp_path, fake_recorder, dora) as c:
        # Template-less fast_validation -> alpha's active (default) template injected.
        c.post(
            "/api/v1/jobs",
            json={"run_id": "run_a", "pipeline": "fast_validation", "params": {}},
        )
        assert dora.last_payload is not None
        assert dora.last_payload["params"]["template"]["name"] == "alpha_default"

        # Selecting strict -> a new job carries it.
        c.post("/api/v1/config/select", json={"category": "validation", "id": "strict"})
        c.post(
            "/api/v1/jobs",
            json={"run_id": "run_a", "pipeline": "fast_validation", "params": {}},
        )
        assert dora.last_payload["params"]["template"]["name"] == "alpha_strict"

        # Switching robot -> bravo's template is now the active one.
        c.post("/api/v1/config/select", json={"category": "robot", "id": "bravo"})
        c.post(
            "/api/v1/jobs",
            json={"run_id": "run_a", "pipeline": "fast_validation", "params": {}},
        )
        assert dora.last_payload["params"]["template"]["name"] == "bravo_default"


def test_explicit_template_is_not_overridden(tmp_path: Path, fake_recorder) -> None:
    dora = _FakeDora()
    with _client(tmp_path, fake_recorder, dora) as c:
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
