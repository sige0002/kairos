# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Shared fixtures: a capture store on disk, a stub converter, and one loop.

Every lifecycle test drives the REAL FastAPI app over ``httpx.ASGITransport``
inside a single ``asyncio.run``. The reason is the queue: an export is a
background task, and Starlette's ``TestClient`` runs each request in its own
short-lived event loop, which would take that task down with it between the
POST and the first status poll.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
from collections.abc import AsyncIterator, Callable
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI
from kairos_common.ids import new_capture_id, uuid7

CONVERTER = Path(__file__).with_name("fake_converter.py")

PROFILE_YAML = """\
robot_type: "myrobot"
fps: 10
task: "OVERRIDDEN_PER_EXPORT"
observations:
  - key: "observation.state"
    topic: "/myrobot/joint_states"
    msg_type: "sensor_msgs/msg/JointState"
    selector: "position"
actions:
  - key: "action"
    topic: "/myrobot/arm_command"
    msg_type: "sensor_msgs/msg/JointState"
    selector: "position"
"""


@pytest.fixture
def data_dir(tmp_path: Path) -> Path:
    """An empty capture store root (``objects/`` + ``exports/``)."""
    (tmp_path / "objects").mkdir()
    (tmp_path / "exports").mkdir()
    return tmp_path


@pytest.fixture
def make_capture(data_dir: Path) -> Callable[..., str]:
    """Create ``objects/<capture_id>/`` with the two files staging links.

    A real UUIDv7, not a readable fake: the id is validated wherever it becomes
    a path segment, so anything else would only ever exercise the rejection.
    """

    def _make(*, task_json: str | None = None, mcap: bool = True) -> str:
        capture_id = new_capture_id()
        directory = data_dir / "objects" / capture_id
        directory.mkdir(parents=True)
        if mcap:
            (directory / f"{capture_id}.mcap").write_bytes(b"\x89MCAP0\r\n")
        (directory / "metadata.yaml").write_text("rosbag2_bagfile_information:\n")
        if task_json is not None:
            (directory / "task.json").write_text(
                json.dumps({"task": task_json}), encoding="utf-8"
            )
        return capture_id

    return _make


@pytest.fixture
def profile_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> str:
    """A profile in the scanned library, and the env that points the scan at it.

    Submission requires ``profile_path`` to be a MEMBER of the robot's library
    (not merely an existing file), so the fixture writes it under a real
    ``config/<robot>/lerobot/`` tree and sets the config/robot env the Settings
    read — a bare tmp file would now be rejected, exactly as an attacker's
    ``/etc/hosts`` is.
    """
    config_dir = tmp_path / "config"
    library = config_dir / "myrobot" / "lerobot"
    library.mkdir(parents=True)
    path = library / "default.yaml"
    path.write_text(PROFILE_YAML, encoding="utf-8")
    monkeypatch.setenv("CONFIG_DIR", str(config_dir))
    monkeypatch.setenv("CONFIG_LOCAL_DIR", str(config_dir / "local"))
    monkeypatch.setenv("ROBOT", "myrobot")
    return str(path)


@pytest.fixture
def exporter_env(monkeypatch: pytest.MonkeyPatch) -> Callable[..., None]:
    """Point the service at the stub converter and shrink its timers.

    The polling period and the SIGTERM grace are real deployment knobs; tests
    turn them down so a cancel or a stall is observed in milliseconds instead
    of the production-shaped seconds.
    """

    def _configure(**overrides: str) -> None:
        CONVERTER.chmod(0o755)
        env = {
            "KAIROS_LEROBOT_BIN": str(CONVERTER),
            "KAIROS_LEROBOT_POLL_S": "0.02",
            "KAIROS_LEROBOT_TERM_GRACE_S": "0.5",
            "KAIROS_LEROBOT_STALL_S": "1",
            "KAIROS_LEROBOT_MAX_CONCURRENCY": "1",
            "KAIROS_LEROBOT_WORKERS": "1",
        }
        env.update(overrides)
        for key, value in env.items():
            monkeypatch.setenv(key, value)
        # The stub reads its behaviour from FAKE_*; clear anything a previous
        # configure left set so a test only sees what it asked for.
        for key in list(os.environ):
            if key.startswith("FAKE_") and key not in overrides:
                monkeypatch.delenv(key, raising=False)

    return _configure


@contextlib.asynccontextmanager
async def exporter_client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    """Drive *app* in-process, tearing down any live export on the way out."""
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://exporter"
    ) as client:
        try:
            yield client
        finally:
            await app.state.registry.shutdown()


def new_export_id() -> str:
    """An export_id in the shape the orchestrator issues."""
    return uuid7()


async def wait_for_state(
    client: httpx.AsyncClient,
    export_id: str,
    states: set[str],
    *,
    timeout: float = 10.0,
) -> dict:
    """Poll ``GET /exports/{id}`` until its state is one of *states*."""
    deadline = asyncio.get_running_loop().time() + timeout
    body: dict = {}
    while asyncio.get_running_loop().time() < deadline:
        response = await client.get(f"/exports/{export_id}")
        assert response.status_code == 200, response.text
        body = response.json()
        if body["state"] in states:
            return body
        await asyncio.sleep(0.02)
    raise AssertionError(f"export {export_id} never reached {states}: {body}")


async def wait_until(predicate: Callable[[], bool], *, timeout: float = 5.0) -> None:
    """Poll *predicate* until it holds."""
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.02)
    raise AssertionError("condition never became true")


def episode(capture_id: str, directory: str, task: str | None = None) -> dict:
    """One ``episodes[]`` entry of an export request."""
    return {"capture_id": capture_id, "dir": directory, "task": task}
