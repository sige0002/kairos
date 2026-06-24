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
from rosbag2_recorder.main import create_recorder_app
from rosbag2_recorder.recorder import run_dir


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
        run_id = cmd[cmd.index("--output") + 1].rsplit("/", 1)[-1]
        write_metadata(run_dir(Path(settings.data_dir), run_id))
        return fake_process(cmd)

    session._spawn_process = fake_spawn  # type: ignore[method-assign]
    # Avoid delivering real OS signals from the test (FakeProcess shares our pid).
    session._signal_and_wait = lambda _proc: None  # type: ignore[method-assign]
    return TestClient(app)


def test_healthz_still_served(client: TestClient) -> None:
    assert client.get("/healthz").status_code == 200


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
    assert body["state"] == "recording"
    assert body["started_at"]

    status = client.get("/record/status").json()
    assert status["state"] == "recording"
    assert status["run_id"] == "run_api"

    stopped = client.post("/record/stop")
    assert stopped.status_code == 200
    assert stopped.json()["state"] == "completed"


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


def test_start_parses_split_and_compression(client: TestClient) -> None:
    resp = client.post(
        "/record/start",
        json={
            "topics": ["/a"],
            "run_id": "run_full",
            "compression": "zstd",
            "split": {"max_size_mb": 100, "max_duration_s": 60},
        },
    )
    assert resp.status_code == 201


def test_stop_when_idle_is_200(client: TestClient) -> None:
    resp = client.post("/record/stop")
    assert resp.status_code == 200
    assert resp.json()["state"] == "created"


def test_metadata_404_before_run(client: TestClient) -> None:
    resp = client.get("/record/metadata")
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "no_recording"


def test_metadata_after_run(client: TestClient) -> None:
    client.post("/record/start", json={"topics": ["/joint_states"], "run_id": "run_m"})
    client.post("/record/stop")
    resp = client.get("/record/metadata")
    assert resp.status_code == 200
    body = resp.json()
    assert body["run_id"] == "run_m"
    assert body["manifest"]["state"] == "completed"
    assert body["rosbag2_metadata"]["message_count"] == 42
    # Top-level bytes is the real on-disk size (the fake bag is 1024 bytes).
    assert body["bytes"] == 1024


def test_status_bytes_reflects_file_size(client: TestClient) -> None:
    client.post("/record/start", json={"topics": ["/a"], "run_id": "run_b"})
    client.post("/record/stop")
    status = client.get("/record/status").json()
    assert status["state"] == "completed"
    assert status["bytes"] == 1024  # stat of the recorded mcap, not metadata
