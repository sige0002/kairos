"""Manifest derivation and liveness semantics (no dora binary involved)."""

import os
import subprocess
import time
from pathlib import Path

from dora_live.feed_subscriber import DoraFeedSubscriber
from dora_live.live_config import LiveConfig
from dora_live.supervisor import DataflowSupervisor, derive_manifest
from kairos_common import RecordingConfig
from kairos_common.monitoring.models import QosInfo


def _session_members(sid: int) -> list[int]:
    pids = []
    for pid_s in os.listdir("/proc"):
        if not pid_s.isdigit():
            continue
        try:
            with open(f"/proc/{pid_s}/stat") as f:
                if int(f.read().rsplit(")", 1)[1].split()[3]) == sid:
                    pids.append(int(pid_s))
        except (OSError, ValueError, IndexError):
            continue
    return pids


def _await_session_gone(sid: int, timeout: float = 3.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not _session_members(sid):
            return True
        time.sleep(0.05)
    return False


def _supervisor(tmp_path: Path) -> DataflowSupervisor:
    return DataflowSupervisor(
        config=None,
        feed=DoraFeedSubscriber(enable_rclpy=False),
        workdir=tmp_path,
        control_url="http://127.0.0.1:9",
    )


def test_terminate_proc_kills_whole_session(tmp_path: Path):
    # Faithful stand-in for `dora run` + a node: with job control (set -m)
    # bash puts the background child into its OWN process group — exactly
    # what dora does to its nodes — so a killpg on the leader misses it and
    # only the session sweep can reach it.
    proc = subprocess.Popen(
        ["bash", "-c", "set -m; sleep 30 & wait"], start_new_session=True
    )
    time.sleep(0.3)
    assert len(_session_members(proc.pid)) >= 2  # leader + own-group child
    sup = _supervisor(tmp_path)
    sup._proc = proc
    sup._terminate_proc()
    assert _await_session_gone(proc.pid), "own-group child survived terminate"


def test_dead_leader_leftovers_swept(tmp_path: Path):
    # Leader dies on its own (the crash path) leaving an own-group orphan in
    # the session — the field incident: an orphaned webrtc node reparented to
    # PID 1 kept port 8007 LISTENing and every respawn died on EADDRINUSE.
    proc = subprocess.Popen(
        ["bash", "-c", "set -m; sleep 30 & exec sleep 0.05"],
        start_new_session=True,
    )
    proc.wait(timeout=5.0)  # leader gone, `sleep 30` orphan remains
    assert _session_members(proc.pid), "orphan should keep the session alive"
    sup = _supervisor(tmp_path)
    sup._proc = proc
    sup._terminate_proc()
    assert _await_session_gone(proc.pid), "dead-leader orphan not swept"


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
