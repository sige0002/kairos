# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Shared pytest fixtures for the rosbag2_recorder tests.

The tests run without ROS 2 installed, so the ``ros2 bag record`` subprocess is
always mocked. :class:`FakeProcess` stands in for ``subprocess.Popen``; tests
that want a finalised capture also drop a rosbag2 ``metadata.yaml`` into the
capture directory via :func:`write_fake_metadata`.

Both helpers are also exposed as fixtures (``fake_process``, ``write_metadata``)
so tests get them via injection. That keeps the suite importable under both
pytest import modes (the service-local ``prepend`` run and the repo-wide
``importlib`` run), where a bare ``from conftest import ...`` would not resolve.
"""

from __future__ import annotations

import os
import subprocess
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
import yaml
from kairos_common import Settings

# ``rosbag2_recorder.main`` builds its app at import time, and building it mints
# ``instance.json`` into DATA_DIR (contract §1). Collection alone would therefore
# write into the checkout's ./data. Point DATA_DIR at a scratch directory before
# any test module imports it; every test that cares supplies its own tmp_path
# Settings anyway.
os.environ.setdefault("DATA_DIR", tempfile.mkdtemp(prefix="kairos-recorder-tests-"))


class FakeProcess:
    """Minimal ``subprocess.Popen`` stand-in for the bag record process.

    Records the argv it was "spawned" with, reports a real (this-process) pid so
    ``os.getpgid`` works, and treats ``wait`` as an immediate clean exit.

    ``alive`` backs :meth:`poll`: by default the fake is treated as a still
    running recorder (so the start-up "did the output dir appear?" check sees a
    live process). Set ``alive=False`` to simulate a process that exited
    immediately without recording (a start failure).

    ``wait_timeouts`` is the delayed-exit seam, counted in ``wait()`` CALLS
    rather than seconds (the poll-count convention from the 2026-08-07 timing
    sweep): the first N waits raise ``TimeoutExpired`` with the process still
    alive, and only then does a wait return. Before this existed the fake was
    STRUCTURALLY unable to time out, which made the recorder's
    SIGINT→SIGTERM→SIGKILL escalation unreachable from any fake-driven test.
    """

    def __init__(
        self,
        cmd: list[str],
        returncode: int = 0,
        alive: bool = True,
        wait_timeouts: int = 0,
    ) -> None:
        self.cmd = cmd
        self.pid = os.getpid()
        self.returncode = returncode
        self._alive = alive
        self.signals: list[int] = []
        self.wait_timeouts = wait_timeouts
        self.wait_calls = 0

    def poll(self) -> int | None:
        return None if self._alive else self.returncode

    def wait(self, timeout: float | None = None) -> int:
        self.wait_calls += 1
        if self.wait_timeouts > 0:
            self.wait_timeouts -= 1
            raise subprocess.TimeoutExpired(self.cmd, timeout if timeout else 0)
        self._alive = False
        return self.returncode


@pytest.fixture
def data_dir(tmp_path: Path) -> Path:
    """A writable temp ``DATA_DIR``.

    Deliberately empty: creating ``objects/`` is the recorder's job (§2), and a
    fixture that pre-created it would hide a failure to do so.
    """
    return tmp_path


@pytest.fixture
def settings(data_dir: Path) -> Settings:
    """Settings pointed at the temp data dir (no .env needed)."""
    return Settings(data_dir=str(data_dir))


def write_fake_metadata(
    capture_dir: Path,
    topics: list[tuple[str, str]] | None = None,
    message_count: int = 42,
    size_bytes: int = 1024,
) -> Path:
    """Write a minimal rosbag2 ``metadata.yaml`` + a real ``.mcap`` into a capture.

    *topics* is a list of ``(name, type)`` pairs. The metadata structure mirrors
    the subset rosbag2 actually emits: note the ``files:`` entry carries NO
    ``size`` field (rosbag2 omits it in this format), so the recorder must
    measure on-disk size by stat'ing the bag file. To exercise that, an actual
    bag file of *size_bytes* bytes is created on disk. rosbag2 names it after
    the ``--output`` directory, which since v2 is the capture_id.
    """
    topics = topics or [("/joint_states", "sensor_msgs/msg/JointState")]
    capture_dir.mkdir(parents=True, exist_ok=True)
    mcap_name = f"{capture_dir.name}_0.mcap"
    (capture_dir / mcap_name).write_bytes(b"\x00" * size_bytes)
    info: dict[str, Any] = {
        "rosbag2_bagfile_information": {
            "message_count": message_count,
            "files": [{"path": mcap_name}],  # no "size" key, as in real metadata
            "topics_with_message_count": [
                {
                    "topic_metadata": {"name": name, "type": type_},
                    "message_count": message_count,
                }
                for name, type_ in topics
            ],
        }
    }
    path = capture_dir / "metadata.yaml"
    path.write_text(yaml.safe_dump(info), encoding="utf-8")
    return path


@pytest.fixture
def fake_process() -> type[FakeProcess]:
    """Inject the :class:`FakeProcess` class (import-mode independent)."""
    return FakeProcess


@pytest.fixture
def write_metadata() -> Callable[..., Path]:
    """Inject :func:`write_fake_metadata` (import-mode independent)."""
    return write_fake_metadata
