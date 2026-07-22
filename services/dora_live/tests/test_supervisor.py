"""Manifest derivation and liveness semantics (no dora binary involved)."""

from pathlib import Path

from dora_live.feed_subscriber import DoraFeedSubscriber
from dora_live.supervisor import DataflowSupervisor, derive_manifest


def test_derive_manifest_splits_pending():
    manifest, pending = derive_manifest(
        ["/a", "/b", "/c"],
        {"/a": "sensor_msgs/msg/JointState", "/c": "std_msgs/msg/String"},
    )
    assert [t.name for t in manifest.topics] == ["/a", "/c"]
    assert pending == ["/b"]
    assert manifest.topics[0].ros_type == "sensor_msgs/msg/JointState"


def test_derive_manifest_empty_allowlist():
    manifest, pending = derive_manifest([], {})
    assert manifest.topics == [] and pending == []


def test_degraded_cooloff_self_recovers(tmp_path: Path):
    import time

    feed = DoraFeedSubscriber(enable_rclpy=False)
    sup = DataflowSupervisor(
        config=None, feed=feed, workdir=tmp_path, control_url="http://127.0.0.1:9"
    )
    sup._degraded = True
    sup._crashes = [time.monotonic() - 700.0]  # last crash beyond the cooloff
    sup._ensure_running()
    assert sup._degraded is False and sup._crashes == []
    # a fresh crash inside the window keeps it degraded
    sup._degraded = True
    sup._crashes = [time.monotonic()]
    sup._ensure_running()
    assert sup._degraded is True


def test_supervisor_alive_semantics(tmp_path: Path):
    feed = DoraFeedSubscriber(enable_rclpy=False)
    sup = DataflowSupervisor(
        config=None,
        feed=feed,
        workdir=tmp_path,
        control_url="http://127.0.0.1:9",
    )
    # No allowlist and no manifest -> vacuously alive (nothing to run).
    assert sup.alive() is True
    status = sup.status()
    assert status["topics"] == [] and status["pending"] == []
    # Feed folds supervisor liveness into readiness.
    feed.start()
    assert feed.is_up() is True
    feed.stop()
