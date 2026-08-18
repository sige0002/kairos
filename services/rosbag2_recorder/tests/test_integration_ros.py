# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
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
from kairos_common.capture_sidecars import capture_dir, read_object_manifest
from rosbag2_recorder.models import RecordStartRequest, RunState
from rosbag2_recorder.recorder import RecorderSession

pytestmark = pytest.mark.skipif(
    shutil.which("ros2") is None,
    reason="ROS 2 (ros2 CLI) not installed; run this in the recorder container.",
)


def test_real_ros2_bag_record_roundtrip(tmp_path: Path) -> None:
    settings = Settings(data_dir=str(tmp_path))
    session = RecorderSession(settings, None)

    started = session.start(RecordStartRequest(topics="all", run_id="it_run"))
    # Give rosbag2 a moment to come up and discover the graph.
    time.sleep(3.0)
    status = session.stop()

    assert status.state is RunState.completed
    capture_id = started.capture_id
    assert capture_id is not None
    out = capture_dir(tmp_path, capture_id)
    assert (out / "metadata.yaml").exists()
    # rosbag2 names its files after the --output directory, which is the
    # capture_id; the run_id survives as the manifest's display name.
    assert any(out.glob(f"{capture_id}_*.mcap"))

    read = read_object_manifest(out)
    assert read.ok, read.error
    assert read.manifest is not None
    assert read.manifest.run_id == "it_run"
    assert read.manifest.state == "completed"
