# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
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
from api_orchestrator.models import Capture, CaptureState
from conftest import stop_owned
from fastapi.testclient import TestClient
from kairos_common import Settings


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


# A fixed UUIDv7 so the fake dora's status body can name the same capture the
# request did without threading the id through the transport.
_CAPTURE_ID = "01920000-0000-7000-8000-000000000001"


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
                    "capture_id": _CAPTURE_ID,
                    "pipeline": "fast_validation",
                    "state": "succeeded",
                    "progress": 1.0,
                    "logs_tail": [],
                },
            )
        return httpx.Response(404, json={"error": {"code": "nf", "message": path}})


def _seed_capture(client: TestClient) -> str:
    """A terminal capture for the job router to accept a job against.

    ``POST /api/v1/jobs`` refuses an unknown capture (§10.5 keys every job by
    capture_id), so a template-injection test needs a real one to aim at.
    """
    store = client.app.state.capture_store
    store.create_capture(
        Capture(
            capture_id=_CAPTURE_ID,
            run_id="run_a",
            state=CaptureState.completed,
            started_at="2026-08-01T00:00:00.000Z",
        )
    )
    return _CAPTURE_ID


def _client(tmp_path: Path, fake_recorder, dora: _FakeDora) -> TestClient:
    root = tmp_path / "config"
    _build_tree(root)
    settings = Settings(
        data_dir=str(tmp_path / "data"),
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
    app = create_orchestrator_app(settings, http_client=http_client)
    return TestClient(app)


def test_tabs_registry_is_retired(client) -> None:
    """Console v2 fixes its tabs in the frontend; the legacy backend registry
    stays as an EMPTY list so old clients deserialize cleanly but nothing is
    advertised (Google review F6: dead v1 contract removed)."""
    assert client.get("/api/v1/config").json()["tabs"] == []


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


def test_stream_editor_can_create_the_file_for_a_streamless_robot(
    tmp_path: Path, fake_recorder
) -> None:
    """Selecting a robot with a config dir but no stream/ keeps a WRITE target.

    Before 2026-08-12, only the startup path had one — after a select the
    path went null and PUT answered 404, so whether the editor worked
    depended on how the robot became active, not on the robot.
    """
    with _client(tmp_path, fake_recorder, _FakeDora()) as c:
        c.post("/api/v1/config/select", json={"category": "robot", "id": "charlie"})
        body = c.get("/api/v1/config/stream").json()
        assert body["config"] is None
        assert body["path"] is not None
        assert body["path"].endswith("charlie/stream/default.yaml")

        resp = c.put(
            "/api/v1/config/stream",
            json={"config": {"columns": 1, "panes": [{"topic": "/c/cam"}]}},
        )
        assert resp.status_code == 200
        created = Path(body["path"])
        assert created.exists()
        assert c.get("/api/v1/config").json()["stream"]["columns"] == 1


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
        capture_id = _seed_capture(c)
        # Template-less fast_validation -> alpha's active (default) template injected.
        c.post(
            "/api/v1/jobs",
            json={
                "capture_id": capture_id,
                "pipeline": "fast_validation",
                "params": {},
            },
        )
        assert dora.last_payload is not None
        assert dora.last_payload["params"]["template"]["name"] == "alpha_default"

        # Selecting strict -> a new job carries it.
        c.post("/api/v1/config/select", json={"category": "validation", "id": "strict"})
        c.post(
            "/api/v1/jobs",
            json={
                "capture_id": capture_id,
                "pipeline": "fast_validation",
                "params": {},
            },
        )
        assert dora.last_payload["params"]["template"]["name"] == "alpha_strict"

        # Switching robot -> bravo's template is now the active one.
        c.post("/api/v1/config/select", json={"category": "robot", "id": "bravo"})
        c.post(
            "/api/v1/jobs",
            json={
                "capture_id": capture_id,
                "pipeline": "fast_validation",
                "params": {},
            },
        )
        assert dora.last_payload["params"]["template"]["name"] == "bravo_default"


def test_robot_config_describes_active_robot(tmp_path: Path, fake_recorder) -> None:
    with _client(tmp_path, fake_recorder, _FakeDora()) as c:
        body = c.get("/api/v1/config/robots/alpha").json()
        assert body["robot"] == "alpha"
        assert body["active"] is True
        assert body["local"] is False
        # Derived summary comes from the recording file's parsed content.
        assert body["summary"]["robot_name"] == "alpha"
        assert body["summary"]["default_topics"] == ["/a", "/b"]
        # ros_domain_id is not a RecordingConfig field, so it is absent here.
        assert body["summary"]["ros_domain_id"] is None
        # Every aspect the robot has is present with parsed content.
        rec = body["aspects"]["recording"]
        assert rec["id"] == "default"
        assert rec["content"]["default_topics"] == ["/a", "/b"]
        assert body["aspects"]["stream"]["content"]["columns"] == 2
        assert body["aspects"]["validation"]["content"]["name"] == "alpha_default"
        assert (
            body["aspects"]["validators"]["content"]["gap_threshold_multiplier"] == 5.0
        )


def test_robot_config_reads_non_active_robot_without_switching(
    tmp_path: Path, fake_recorder
) -> None:
    with _client(tmp_path, fake_recorder, _FakeDora()) as c:
        body = c.get("/api/v1/config/robots/bravo").json()
        assert body["active"] is False
        assert body["summary"]["default_topics"] == ["/x"]
        assert body["aspects"]["recording"]["content"]["robot_name"] == "bravo"
        # Inspecting a non-active robot must NOT change the active selection.
        assert c.get("/api/v1/config/options").json()["active_robot"] == "alpha"


def test_robot_config_local_robot_missing_aspects_are_null(
    tmp_path: Path, fake_recorder
) -> None:
    with _client(tmp_path, fake_recorder, _FakeDora()) as c:
        body = c.get("/api/v1/config/robots/charlie").json()
        assert body["local"] is True
        assert body["aspects"]["recording"]["content"]["default_topics"] == ["/c"]
        # charlie has only a recording aspect; the rest resolve to null.
        assert body["aspects"]["stream"] is None
        assert body["aspects"]["validation"] is None
        assert body["aspects"]["validators"] is None


def test_robot_config_honours_active_robot_option_pick(
    tmp_path: Path, fake_recorder
) -> None:
    with _client(tmp_path, fake_recorder, _FakeDora()) as c:
        c.post("/api/v1/config/select", json={"category": "recording", "id": "minimal"})
        rec = c.get("/api/v1/config/robots/alpha").json()["aspects"]["recording"]
        assert rec["id"] == "minimal"
        assert rec["content"]["default_topics"] == ["/a"]


def test_robot_config_unknown_robot_is_404(tmp_path: Path, fake_recorder) -> None:
    with _client(tmp_path, fake_recorder, _FakeDora()) as c:
        assert c.get("/api/v1/config/robots/nope").status_code == 404
        # A path-traversal-ish name is not a known robot either.
        assert c.get("/api/v1/config/robots/local").status_code == 404


def test_failed_select_rolls_back_the_selection(tmp_path: Path, fake_recorder) -> None:
    """S1-3: a select whose files fail to load must be all-or-nothing.

    Picking a robot with a broken recording YAML used to leave the catalog on
    the NEW robot while the live recording config stayed the OLD robot's — the
    switch "failed" on screen but every next capture was re-labelled anyway.
    """
    dora = _FakeDora()
    with _client(tmp_path, fake_recorder, dora) as c:
        # A robot whose recording config cannot parse (schema violation).
        root = tmp_path / "config"
        _write(
            root / "delta/recording/default.yaml",
            "robot_name: delta\ndefault_topics: not_a_list\n",
        )
        resp = c.post(
            "/api/v1/config/select", json={"category": "robot", "id": "delta"}
        )
        assert resp.status_code == 422
        assert resp.json()["error"]["code"] == "invalid_config"
        # The selection rolled back with the failure: catalog AND live config
        # still alpha's.
        options = c.get("/api/v1/config/options").json()
        assert options["active_robot"] == "alpha"
        assert c.get("/api/v1/config").json()["defaults"]["default_topics"] == [
            "/a",
            "/b",
        ]


def test_start_payload_carries_the_live_qos_patterns(
    tmp_path: Path, fake_recorder
) -> None:
    """S1-3: the live config's QoS patterns ride on every recorder start.

    The recorder's own ``topic_qos_overrides`` were loaded at ITS startup; a
    robot switch hot-swaps only the orchestrator's copy. Sending the live
    patterns with the start is what makes the switch real for recording."""
    dora = _FakeDora()
    with _client(tmp_path, fake_recorder, dora) as c:
        root = tmp_path / "config"
        _write(
            root / "alpha/recording/qos.yaml",
            "robot_name: alpha\ndefault_topics: [/a, /b]\n"
            "topic_qos_overrides:\n"
            "  - {pattern: '/a*', reliability: reliable, "
            "durability: volatile, depth: 5}\n",
        )
        c.post("/api/v1/config/select", json={"category": "recording", "id": "qos"})
        assert c.post("/api/v1/record/start", json={"topics": ["/a"]}).status_code in (
            200,
            201,
        )
        assert fake_recorder.last_start_payload["qos_override_patterns"] == [
            {
                "pattern": "/a*",
                "reliability": "reliable",
                "durability": "volatile",
                "depth": 5,
            }
        ]
        assert stop_owned(c).status_code == 200
        # Switching back to the override-free option must ASSERT emptiness (an
        # empty list, not an absent field): "no overrides" has to supersede a
        # stale file on the recorder's side too.
        c.post("/api/v1/config/select", json={"category": "recording", "id": "default"})
        c.post("/api/v1/record/start", json={"topics": ["/a"]})
        assert fake_recorder.last_start_payload["qos_override_patterns"] == []


def test_explicit_template_is_not_overridden(tmp_path: Path, fake_recorder) -> None:
    dora = _FakeDora()
    with _client(tmp_path, fake_recorder, dora) as c:
        capture_id = _seed_capture(c)
        explicit = {"name": "mine", "version": 1, "required_topics": []}
        c.post(
            "/api/v1/jobs",
            json={
                "capture_id": capture_id,
                "pipeline": "fast_validation",
                "params": {"template": explicit},
            },
        )
        assert dora.last_payload["params"]["template"]["name"] == "mine"
