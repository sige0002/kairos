"""LIVE_CONFIG loading, topic-set resolution, QoS precedence, video rules."""

from pathlib import Path

import pytest
from dora_live.live_config import (
    LiveConfig,
    load_live_config,
    resolve_live_topics,
    resolve_topic_qos,
    resolve_video_codec,
)
from kairos_common import RecordingConfig
from kairos_common.monitoring.models import QosInfo


def _recording(**kwargs) -> RecordingConfig:
    base = {
        "robot_name": "t",
        "default_topics": ["/a", "/b", "/cam/compressed"],
    }
    base.update(kwargs)
    return RecordingConfig.model_validate(base)


# ---- loading ----------------------------------------------------------------


def test_load_absent_file_is_all_defaults(tmp_path: Path):
    cfg = load_live_config(tmp_path / "nope.yaml")
    assert cfg == LiveConfig()
    assert load_live_config(None) == LiveConfig()


def test_load_parses_full_schema(tmp_path: Path):
    p = tmp_path / "live.yaml"
    p.write_text(
        "topics:\n  - /x\nextra_topics:\n  - /y\nexclude:\n  - '/z*'\n"
        "qos_overrides:\n"
        "  - pattern: '/x'\n    reliability: reliable\n"
        "    durability: transient_local\n    depth: 5\n"
        "video:\n  - pattern: '/x'\n    codec: ffmpeg\n"
        "queue_size: 500\n"
    )
    cfg = load_live_config(p)
    assert cfg.topics == ["/x"] and cfg.extra_topics == ["/y"]
    assert cfg.qos_overrides[0].depth == 5
    assert cfg.video[0].codec == "ffmpeg"
    assert cfg.queue_size == 500


def test_load_rejects_unknown_keys(tmp_path: Path):
    p = tmp_path / "live.yaml"
    p.write_text("topcis: ['/typo']\n")
    with pytest.raises(Exception, match="topcis"):
        load_live_config(p)


# ---- topic-set resolution ---------------------------------------------------


def test_topics_inherit_recording_by_default():
    assert resolve_live_topics(LiveConfig(), _recording()) == [
        "/a",
        "/b",
        "/cam/compressed",
    ]


def test_topics_explicit_list_replaces_recording():
    cfg = LiveConfig(topics=["/only"])
    assert resolve_live_topics(cfg, _recording()) == ["/only"]


def test_extra_and_exclude():
    cfg = LiveConfig(extra_topics=["/diag", "/a"], exclude=["/cam/*"])
    assert resolve_live_topics(cfg, _recording()) == ["/a", "/b", "/diag"]


def test_no_recording_config_and_no_topics_is_empty():
    assert resolve_live_topics(LiveConfig(), None) == []


# ---- QoS precedence ---------------------------------------------------------


def test_qos_live_override_wins():
    cfg = LiveConfig(
        qos_overrides=[
            {
                "pattern": "/cam/*",
                "reliability": "reliable",
                "durability": "transient_local",
                "depth": 2,
            }
        ]
    )
    qos = resolve_topic_qos(
        "/cam/compressed",
        [QosInfo(reliability="best_effort", durability="volatile", depth=10)],
        cfg,
        _recording(),
    )
    assert (qos.reliability, qos.durability, qos.depth) == (
        "reliable",
        "transient_local",
        2,
    )


def test_qos_falls_back_to_recording_override():
    rec = _recording(
        topic_qos_overrides=[
            {
                "pattern": "/b",
                "reliability": "reliable",
                "durability": "volatile",
                "depth": 7,
            }
        ]
    )
    qos = resolve_topic_qos("/b", [], LiveConfig(), rec)
    assert (qos.reliability, qos.depth) == ("reliable", 7)


def test_qos_auto_matches_publishers():
    pubs = [
        QosInfo(reliability="reliable", durability="volatile", depth=10),
        QosInfo(reliability="best_effort", durability="volatile", depth=5),
    ]
    qos = resolve_topic_qos("/a", pubs, LiveConfig(), _recording())
    # Compatible side: best_effort if any publisher is best_effort.
    assert qos.reliability == "best_effort" and qos.depth == 5


def test_qos_no_publishers_uses_default_depth():
    qos = resolve_topic_qos("/a", [], LiveConfig(), None, default_depth=42)
    assert qos.reliability == "best_effort" and qos.depth == 42


# ---- video rules ------------------------------------------------------------


def test_video_type_defaults():
    cfg = LiveConfig()
    assert resolve_video_codec("/c", "sensor_msgs/msg/CompressedImage", cfg) == "image"
    assert (
        resolve_video_codec("/f", "ffmpeg_image_transport_msgs/msg/FFMPEGPacket", cfg)
        == "ffmpeg"
    )
    # Raw Image never joins by default (RustDDS fragmentation-loss regime).
    assert resolve_video_codec("/r", "sensor_msgs/msg/Image", cfg) is None
    assert resolve_video_codec("/j", "sensor_msgs/msg/JointState", cfg) is None


def test_video_rule_opts_raw_in_and_off_out():
    cfg = LiveConfig(
        video=[
            {"pattern": "/raw_cam", "codec": "raw"},
            {"pattern": "**/compressedDepth", "codec": "off"},
        ]
    )
    assert resolve_video_codec("/raw_cam", "sensor_msgs/msg/Image", cfg) == "raw"
    assert (
        resolve_video_codec(
            "/d/compressedDepth", "sensor_msgs/msg/CompressedImage", cfg
        )
        is None
    )


def test_video_raw_rule_on_non_image_type_is_ignored():
    cfg = LiveConfig(video=[{"pattern": "/x", "codec": "raw"}])
    assert resolve_video_codec("/x", "sensor_msgs/msg/JointState", cfg) is None
