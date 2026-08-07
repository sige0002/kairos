"""HTTP-layer tests: routes, status codes, and start-body parsing/validation.

Exercises the FastAPI app end to end with the subprocess mocked, so request
parsing, response shapes, and the unified error envelope are covered without
ROS 2.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from kairos_common import Settings
from kairos_common.ids import is_uuid7
from rosbag2_recorder.main import create_recorder_app


@pytest.fixture
def client(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
    fake_process: type,
    write_metadata: Callable[..., Path],
) -> TestClient:
    """A TestClient whose recorder session uses a fake subprocess.

    ``get_settings`` is cached process-wide, so patch it to return our
    temp-dir settings before the app (and its session) are built.
    """
    import kairos_common
    import rosbag2_recorder.main as main_mod

    monkeypatch.setattr(kairos_common, "get_settings", lambda: settings)
    monkeypatch.setattr(main_mod, "get_settings", lambda: settings)

    app = create_recorder_app()
    session = app.state.session
    # Don't incur the real start-delay ramp-up wait in API contract tests.
    if session._config is not None:
        session._config.recording.start_delay_s = 0

    def fake_spawn(cmd: list[str]) -> Any:
        write_metadata(Path(cmd[cmd.index("--output") + 1]))
        return fake_process(cmd)

    session._spawn_process = fake_spawn  # type: ignore[method-assign]
    # Avoid delivering real OS signals from the test: FakeProcess reports OUR
    # pid, so a real killpg here would terminate the test runner itself.
    session._signal_and_wait = lambda _proc: None  # type: ignore[method-assign]
    session._terminate_failed_start = lambda _proc: None  # type: ignore[method-assign]
    # The arming gate needs ROS; hand prepare() a matched-but-inert pair so the
    # two-phase route runs without it.
    session._prepare_arm = lambda *_a, **_k: (object(), object(), object(), False)  # type: ignore[method-assign]
    session._resume_armed = lambda _armed: None  # type: ignore[method-assign]
    session._refresh_arming_locked = lambda: None  # type: ignore[method-assign]
    return TestClient(app)


def test_healthz_still_served(client: TestClient) -> None:
    assert client.get("/healthz").status_code == 200


def test_record_routes_are_sync_offloaded(client: TestClient) -> None:
    """The /record/* + /readyz handlers are plain ``def`` so Starlette runs them
    in its thread pool instead of on the event loop (REC-H1).

    ``session.start``/``stop`` block synchronously (start delay, arming gate, the
    up-to-30s wait for the bag to exit); an ``async`` handler would freeze every
    request — ``/healthz`` and ``/record/status`` included — for that whole span.
    """
    import inspect

    offloaded = {
        "/record/start",
        "/record/stop",
        "/record/status",
        "/record/metadata",
        "/readyz",
    }
    seen: set[str] = set()
    for route in client.app.routes:
        path = getattr(route, "path", None)
        if path in offloaded:
            seen.add(path)
            assert not inspect.iscoroutinefunction(route.endpoint), (
                f"{path} must be a sync def so Starlette offloads it"
            )
    assert seen == offloaded


def test_readyz_ok_when_writable(client: TestClient) -> None:
    resp = client.get("/readyz")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ready"


def test_start_status_stop_flow(client: TestClient) -> None:
    resp = client.post(
        "/record/start", json={"topics": ["/joint_states"], "run_id": "run_api"}
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["run_id"] == "run_api"
    assert is_uuid7(body["capture_id"])
    assert body["state"] == "recording"
    assert body["started_at"]

    status = client.get("/record/status").json()
    assert status["state"] == "recording"
    assert status["run_id"] == "run_api"
    assert status["capture_id"] == body["capture_id"]

    stopped = client.post("/record/stop")
    assert stopped.status_code == 200
    assert stopped.json()["state"] == "completed"
    assert stopped.json()["capture_id"] == body["capture_id"]


def test_status_exposes_live_capture_ids(client: TestClient) -> None:
    """The rebuild reads this to skip captures the recorder still owns (§8-1)."""
    assert client.get("/record/status").json()["live_capture_ids"] == []

    capture_id = client.post(
        "/record/start", json={"topics": ["/a"], "run_id": "run_live"}
    ).json()["capture_id"]
    assert client.get("/record/status").json()["live_capture_ids"] == [capture_id]

    client.post("/record/stop")
    assert client.get("/record/status").json()["live_capture_ids"] == []


def test_prepare_returns_a_capture_id(client: TestClient) -> None:
    resp = client.post("/record/prepare", json={"topics": ["/a"], "run_id": "run_prep"})
    assert resp.status_code == 201
    body = resp.json()
    assert body["state"] == "armed"
    assert is_uuid7(body["capture_id"])
    # An armed capture is live: its directory exists but has no manifest yet.
    assert client.get("/record/status").json()["live_capture_ids"] == [
        body["capture_id"]
    ]


def test_stop_while_armed_reports_the_cancelled_capture(client: TestClient) -> None:
    """Cancelling an arm over HTTP names the capture that will never appear."""
    armed = client.post(
        "/record/prepare", json={"topics": ["/a"], "run_id": "run_cancel"}
    ).json()
    stopped = client.post("/record/stop").json()
    assert stopped["disarmed_capture_id"] == armed["capture_id"]
    assert stopped["live_capture_ids"] == []
    # An ordinary stop leaves the field null.
    client.post("/record/start", json={"topics": ["/a"], "run_id": "run_plain"})
    assert client.post("/record/stop").json()["disarmed_capture_id"] is None


def test_start_all_topics(client: TestClient) -> None:
    resp = client.post("/record/start", json={"topics": "all", "run_id": "run_all"})
    assert resp.status_code == 201
    assert resp.json()["state"] == "recording"


def test_start_invalid_run_id_is_400(client: TestClient) -> None:
    resp = client.post("/record/start", json={"topics": ["/a"], "run_id": "bad id!"})
    assert resp.status_code == 400
    body = resp.json()
    assert body["error"]["code"] == "invalid_run_id"


def test_start_multi_is_409(client: TestClient) -> None:
    client.post("/record/start", json={"topics": ["/a"], "run_id": "run_1"})
    resp = client.post("/record/start", json={"topics": ["/a"], "run_id": "run_2"})
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "already_recording"


def test_start_missing_run_id_is_422(client: TestClient) -> None:
    # run_id is required by the model -> pydantic/FastAPI 422 in error envelope.
    resp = client.post("/record/start", json={"topics": ["/a"]})
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "validation_error"


def test_start_bad_compression_is_422(client: TestClient) -> None:
    resp = client.post(
        "/record/start",
        json={"topics": ["/a"], "run_id": "run_1", "compression": "gzip"},
    )
    assert resp.status_code == 422


def test_start_parses_split_compression_and_robot(client: TestClient) -> None:
    resp = client.post(
        "/record/start",
        json={
            "topics": ["/a"],
            "run_id": "run_full",
            "compression": "zstd",
            "split": {"max_size_mb": 100, "max_duration_s": 60},
            "robot": "hsr",
        },
    )
    assert resp.status_code == 201
    client.post("/record/stop")
    assert client.get("/record/metadata").json()["manifest"]["robot"] == "hsr"


def test_stop_when_idle_is_200(client: TestClient) -> None:
    resp = client.post("/record/stop")
    assert resp.status_code == 200
    assert resp.json()["state"] == "created"
    assert resp.json()["capture_id"] is None


def test_metadata_404_before_run(client: TestClient) -> None:
    resp = client.get("/record/metadata")
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "no_recording"


def test_metadata_after_run(client: TestClient) -> None:
    started = client.post(
        "/record/start", json={"topics": ["/joint_states"], "run_id": "run_m"}
    ).json()
    client.post("/record/stop")
    resp = client.get("/record/metadata")
    assert resp.status_code == 200
    body = resp.json()
    assert body["run_id"] == "run_m"
    assert body["capture_id"] == started["capture_id"]
    assert body["manifest"]["state"] == "completed"
    assert body["manifest"]["schema_version"] == 2
    assert body["manifest"]["digest_state"] == "pending"
    assert body["rosbag2_metadata"]["message_count"] == 42
    # Top-level bytes is the real on-disk size (the fake bag is 1024 bytes).
    assert body["bytes"] == 1024


def test_status_bytes_reflects_file_size(client: TestClient) -> None:
    client.post("/record/start", json={"topics": ["/a"], "run_id": "run_b"})
    client.post("/record/stop")
    status = client.get("/record/status").json()
    assert status["state"] == "completed"
    assert status["bytes"] == 1024  # stat of the recorded mcap, not metadata
