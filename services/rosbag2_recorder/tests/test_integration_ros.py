"""Integration test against a real ``ros2 bag record``.

SKIPPED unless ROS 2 is installed (``ros2`` on PATH). It is meant to run in the
recorder's Docker image (and against the rosbag-player test harness in
``deploy/test/``), not in the plain-Python unit run. Without a live publisher
this records an empty-but-valid bag; the point is that the real subprocess path,
SIGINT shutdown, and ``metadata.yaml`` finalisation all work.
"""

from __future__ import annotations

import shutil
import time
from pathlib import Path

import pytest
from kairos_common import Settings
from rosbag2_recorder.models import RecordStartRequest, RunState
from rosbag2_recorder.recorder import RecorderSession

pytestmark = pytest.mark.skipif(
    shutil.which("ros2") is None,
    reason="ROS 2 (ros2 CLI) not installed; run this in the recorder container.",
)


def test_real_ros2_bag_record_roundtrip(tmp_path: Path) -> None:
    (tmp_path / "recorded").mkdir(parents=True)
    settings = Settings(data_dir=str(tmp_path))
    session = RecorderSession(settings, None)

    session.start(RecordStartRequest(topics="all", run_id="it_run"))
    # Give rosbag2 a moment to come up and discover the graph.
    time.sleep(3.0)
    status = session.stop()

    assert status.state is RunState.completed
    out = tmp_path / "recorded" / "it_run"
    assert (out / "metadata.yaml").exists()
    assert any(out.glob("it_run_*.mcap"))
