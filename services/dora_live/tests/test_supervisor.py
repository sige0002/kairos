"""Manifest derivation and liveness semantics (no dora binary involved)."""

from pathlib import Path

from dora_live.feed_subscriber import DoraFeedSubscriber
from dora_live.live_config import LiveConfig
from dora_live.supervisor import DataflowSupervisor, derive_manifest
from kairos_common import RecordingConfig
from kairos_common.monitoring.models import QosInfo


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


def test_derive_manifest_resolves_qos_and_video():
    live = LiveConfig(
        qos_overrides=[
            {
                "pattern": "/cam/*",
                "reliability": "best_effort",
                "durability": "volatile",
                "depth": 3,
            }
        ]
    )
    manifest, pending = derive_manifest(
        ["/cam/compressed", "/joints"],
        {
            "/cam/compressed": "sensor_msgs/msg/CompressedImage",
            "/joints": "sensor_msgs/msg/JointState",
        },
        publisher_qos={
            "/joints": [
                QosInfo(reliability="reliable", durability="volatile", depth=10)
            ]
        },
        live_config=live,
    )
    assert pending == []
    cam = manifest.topic("/cam/compressed")
    assert (cam.qos, cam.depth, cam.video) == ("best_effort", 3, "image")
    joints = manifest.topic("/joints")
    # All publishers reliable -> the auto-match subscribes reliable.
    assert (joints.qos, joints.video) == ("reliable", None)
    assert manifest.queue_size == live.queue_size


def test_supervisor_allowlist_from_live_config():
    rec = RecordingConfig.model_validate(
        {"robot_name": "t", "default_topics": ["/a", "/b"]}
    )
    live = LiveConfig(extra_topics=["/c"], exclude=["/b"])
    feed = DoraFeedSubscriber(enable_rclpy=False)
    sup = DataflowSupervisor(
        config=rec,
        feed=feed,
        workdir=Path("/nonexistent"),
        control_url="http://127.0.0.1:9",
        live_config=live,
    )
    assert sup._allowlist == ["/a", "/c"]
    status = sup.status()
    assert status["topics_source"] == "recording"
    assert status["allowlist_total"] == 2


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
