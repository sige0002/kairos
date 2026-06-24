"""Shared pytest fixtures for the rosbag2_recorder tests.

The tests run without ROS 2 installed, so the ``ros2 bag record`` subprocess is
always mocked. :class:`FakeProcess` stands in for ``subprocess.Popen``; tests
that want a finalised run also drop a rosbag2 ``metadata.yaml`` into the run
directory via :func:`write_fake_metadata`.

Both helpers are also exposed as fixtures (``fake_process``, ``write_metadata``)
so tests get them via injection. That keeps the suite importable under both
pytest import modes (the service-local ``prepend`` run and the repo-wide
``importlib`` run), where a bare ``from conftest import ...`` would not resolve.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
import yaml
from kairos_common import Settings


class FakeProcess:
    """Minimal ``subprocess.Popen`` stand-in for the bag record process.

    Records the argv it was "spawned" with, reports a real (this-process) pid so
    ``os.getpgid`` works, and treats ``wait`` as an immediate clean exit.

    ``alive`` backs :meth:`poll`: by default the fake is treated as a still
    running recorder (so the start-up "did the output dir appear?" check sees a
    live process). Set ``alive=False`` to simulate a process that exited
    immediately without recording (a start failure).
    """

    def __init__(self, cmd: list[str], returncode: int = 0, alive: bool = True) -> None:
        self.cmd = cmd
        self.pid = os.getpid()
        self.returncode = returncode
        self._alive = alive
        self.signals: list[int] = []

    def poll(self) -> int | None:
        return None if self._alive else self.returncode

    def wait(self, timeout: float | None = None) -> int:
        self._alive = False
        return self.returncode


@pytest.fixture
def data_dir(tmp_path: Path) -> Path:
    """A writable temp ``DATA_DIR`` with the ``recorded`` root present."""
    (tmp_path / "recorded").mkdir(parents=True, exist_ok=True)
    return tmp_path


@pytest.fixture
def settings(data_dir: Path) -> Settings:
    """Settings pointed at the temp data dir (no .env needed)."""
    return Settings(data_dir=str(data_dir))


def write_fake_metadata(
    run_dir: Path,
    topics: list[tuple[str, str]] | None = None,
    message_count: int = 42,
    size_bytes: int = 1024,
) -> Path:
    """Write a minimal rosbag2 ``metadata.yaml`` + a real ``.mcap`` into *run_dir*.

    *topics* is a list of ``(name, type)`` pairs. The metadata structure mirrors
    the subset rosbag2 actually emits: note the ``files:`` entry carries NO
    ``size`` field (rosbag2 omits it in this format), so the recorder must
    measure on-disk size by stat'ing the bag file. To exercise that, an actual
    ``<run_id>_0.mcap`` of *size_bytes* bytes is created on disk.
    """
    topics = topics or [("/joint_states", "sensor_msgs/msg/JointState")]
    run_dir.mkdir(parents=True, exist_ok=True)
    mcap_name = f"{run_dir.name}_0.mcap"
    (run_dir / mcap_name).write_bytes(b"\x00" * size_bytes)
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
    path = run_dir / "metadata.yaml"
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
