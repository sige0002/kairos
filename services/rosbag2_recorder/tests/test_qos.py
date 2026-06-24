"""QoS resolution + override-file generation from recording config / request."""

from __future__ import annotations

from pathlib import Path

import yaml
from kairos_common import (
    Durability,
    RecordingConfig,
    Reliability,
    TopicQosOverride,
)
from rosbag2_recorder.models import QosProfile
from rosbag2_recorder.qos import (
    build_qos_overrides,
    resolve_topic_qos,
    write_qos_overrides_file,
)


def _config() -> RecordingConfig:
    # Mirrors deploy/config/airoa_hsr.yaml ordering: cameras best_effort first,
    # then a catch-all reliable. First match wins.
    return RecordingConfig(
        robot_name="hsr",
        topic_qos_overrides=[
            TopicQosOverride(
                pattern="**/compressed",
                reliability=Reliability.best_effort,
                durability=Durability.volatile,
                depth=1,
            ),
            TopicQosOverride(
                pattern="/tf_static",
                reliability=Reliability.reliable,
                durability=Durability.transient_local,
                depth=1,
            ),
            TopicQosOverride(
                pattern="*",
                reliability=Reliability.reliable,
                durability=Durability.volatile,
                depth=10,
            ),
        ],
    )


def test_resolve_uses_first_matching_pattern() -> None:
    cfg = _config()
    cam = resolve_topic_qos("/hsrb/hand_camera/image_raw/compressed", cfg, None)
    assert cam is not None
    assert cam.reliability is Reliability.best_effort
    assert cam.depth == 1

    static = resolve_topic_qos("/tf_static", cfg, None)
    assert static is not None
    assert static.durability is Durability.transient_local

    other = resolve_topic_qos("/hsrb/joint_states", cfg, None)
    assert other is not None
    assert other.reliability is Reliability.reliable
    assert other.depth == 10


def test_request_override_takes_precedence_over_config() -> None:
    cfg = _config()
    req = {
        "/hsrb/joint_states": QosProfile(reliability=Reliability.best_effort, depth=5)
    }
    qos = resolve_topic_qos("/hsrb/joint_states", cfg, req)
    assert qos is not None
    assert qos.reliability is Reliability.best_effort
    assert qos.depth == 5


def test_resolve_returns_none_without_config_or_override() -> None:
    # No config + no override -> follow the publisher's offered QoS.
    assert resolve_topic_qos("/anything", None, None) is None


def test_build_and_write_overrides_file(tmp_path: Path) -> None:
    cfg = _config()
    topics = ["/hsrb/hand_camera/image_raw/compressed", "/hsrb/joint_states"]
    overrides = build_qos_overrides(topics, cfg, None)
    assert set(overrides) == set(topics)

    cam = overrides["/hsrb/hand_camera/image_raw/compressed"]
    assert cam["reliability"] == "best_effort"
    assert cam["history"] == "keep_last"
    assert cam["depth"] == 1

    dest = write_qos_overrides_file(overrides, tmp_path / "qos.yaml")
    assert dest is not None
    written = yaml.safe_load(dest.read_text())
    assert written == overrides


def test_write_overrides_file_skips_when_empty(tmp_path: Path) -> None:
    # No config and no request overrides -> nothing to write, no flag passed.
    overrides = build_qos_overrides(["/a", "/b"], None, None)
    assert overrides == {}
    assert write_qos_overrides_file(overrides, tmp_path / "qos.yaml") is None
    assert not (tmp_path / "qos.yaml").exists()


def test_qos_default_is_fallback_for_unmatched_topics() -> None:
    # qos_default applies to any topic with no per-topic / config match.
    default = QosProfile(reliability=Reliability.reliable, depth=7)
    qos = resolve_topic_qos("/anything", None, None, qos_default=default)
    assert qos is not None
    assert qos.reliability is Reliability.reliable
    assert qos.depth == 7


def test_qos_default_does_not_override_per_topic_or_config() -> None:
    cfg = _config()
    default = QosProfile(reliability=Reliability.reliable, depth=99)
    # Config pattern (camera best_effort) wins over qos_default.
    cam = resolve_topic_qos(
        "/hsrb/hand_camera/image_raw/compressed", cfg, None, qos_default=default
    )
    assert cam is not None
    assert cam.reliability is Reliability.best_effort
    assert cam.depth == 1
    # Per-request override wins over qos_default too.
    req = {"/x": QosProfile(depth=3)}
    assert resolve_topic_qos("/x", None, req, qos_default=default).depth == 3


def test_no_qos_default_still_follows_publisher() -> None:
    # Absent qos_default -> None (follow publisher), unchanged default behaviour.
    assert resolve_topic_qos("/anything", None, None, qos_default=None) is None


def test_build_overrides_applies_qos_default() -> None:
    default = QosProfile(reliability=Reliability.reliable, depth=5)
    overrides = build_qos_overrides(["/a", "/b"], None, None, qos_default=default)
    assert set(overrides) == {"/a", "/b"}
    assert overrides["/a"]["reliability"] == "reliable"
    assert overrides["/a"]["depth"] == 5
