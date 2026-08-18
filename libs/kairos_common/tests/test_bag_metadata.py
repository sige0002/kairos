# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Topic signature derived from a bag's rosbag2 ``metadata.yaml``.

These pin the properties a catalog consumer relies on: the signature is stable
across orderings, it distinguishes different topic sets (the 2026-07-26 ML
finding: two robots' schemas inside one dataset group), a topic that recorded
nothing does not count as present, and an unreadable bag stays honestly unknown
instead of hashing to something that would compare equal.
"""

from __future__ import annotations

from pathlib import Path

import yaml
from kairos_common.bag_metadata import (
    read_bag_metadata,
    signature_from_metadata,
    topic_pairs,
    topic_signature,
)


def _meta(*topics: tuple[str, str, int]) -> dict:
    """A rosbag2 metadata payload from ``(name, type, message_count)`` triples."""
    return {
        "rosbag2_bagfile_information": {
            "version": 9,
            "storage_identifier": "mcap",
            "message_count": sum(c for _, _, c in topics),
            "topics_with_message_count": [
                {
                    "topic_metadata": {"name": name, "type": type_},
                    "message_count": count,
                }
                for name, type_, count in topics
            ],
        }
    }


HSR = _meta(
    ("/hsrb/joint_states", "sensor_msgs/msg/JointState", 600),
    ("/hsrb/hand_camera/image_raw/compressed", "sensor_msgs/msg/CompressedImage", 300),
)
MYROBOT = _meta(
    ("/left_arm_controller/joint_states", "sensor_msgs/msg/JointState", 600),
    ("/camera/head/color/image_raw/compressed", "sensor_msgs/msg/CompressedImage", 300),
)


def test_same_topics_hash_equal_regardless_of_order() -> None:
    reordered = _meta(
        (
            "/hsrb/hand_camera/image_raw/compressed",
            "sensor_msgs/msg/CompressedImage",
            7,
        ),
        ("/hsrb/joint_states", "sensor_msgs/msg/JointState", 11),
    )
    # Message counts differ; only the SET of (name, type) decides the signature.
    assert signature_from_metadata(HSR) == signature_from_metadata(reordered)


def test_disjoint_topic_sets_hash_differently() -> None:
    """The real finding: one group held both of these and looked homogeneous."""
    hsr = signature_from_metadata(HSR)
    myrobot = signature_from_metadata(MYROBOT)
    assert hsr is not None and myrobot is not None
    assert hsr.hash != myrobot.hash
    assert hsr.count == myrobot.count == 2  # same size, different set


def test_same_name_different_type_is_a_different_schema() -> None:
    a = signature_from_metadata(
        _meta(("/joint_states", "sensor_msgs/msg/JointState", 5))
    )
    b = signature_from_metadata(
        _meta(("/joint_states", "custom_msgs/msg/JointState", 5))
    )
    assert a is not None and b is not None
    assert a.hash != b.hash


def test_a_topic_that_recorded_nothing_is_not_part_of_the_set() -> None:
    """A subscribed-but-silent topic is a MISSING modality, so it must show up
    as a different signature rather than hide inside the expected one."""
    with_silent = _meta(
        ("/hsrb/joint_states", "sensor_msgs/msg/JointState", 600),
        (
            "/hsrb/hand_camera/image_raw/compressed",
            "sensor_msgs/msg/CompressedImage",
            300,
        ),
        ("/hsrb/wrist_wrench/raw", "geometry_msgs/msg/WrenchStamped", 0),
    )
    signature = signature_from_metadata(with_silent)
    assert signature is not None
    assert signature.count == 2
    assert signature == signature_from_metadata(HSR)


def test_unknown_topics_stay_none_never_a_hash() -> None:
    assert signature_from_metadata(None) is None
    assert signature_from_metadata({}) is None
    assert topic_pairs({"rosbag2_bagfile_information": {}}) is None
    # A metadata file that lists topics but none carried messages is a VALID
    # empty set (a real, degenerate recording) — not unknown.
    empty = signature_from_metadata(_meta(("/a", "std_msgs/msg/Bool", 0)))
    assert empty is not None
    assert empty.count == 0


def test_reads_a_flat_payload_too() -> None:
    """Some writers omit the rosbag2_bagfile_information envelope."""
    flat = {
        "topics_with_message_count": [
            {
                "topic_metadata": {"name": "/a", "type": "std_msgs/msg/Bool"},
                "message_count": 2,
            }
        ]
    }
    signature = signature_from_metadata(flat)
    assert signature is not None and signature.count == 1


def test_topic_signature_reads_the_bag_dir(tmp_path: Path) -> None:
    bag = tmp_path / "001"
    bag.mkdir()
    (bag / "metadata.yaml").write_text(yaml.safe_dump(HSR), encoding="utf-8")
    signature = topic_signature(bag)
    assert signature is not None
    assert signature == signature_from_metadata(HSR)


def test_missing_or_malformed_metadata_never_raises(tmp_path: Path) -> None:
    missing = tmp_path / "missing"
    missing.mkdir()
    assert read_bag_metadata(missing) is None
    assert topic_signature(missing) is None

    broken = tmp_path / "broken"
    broken.mkdir()
    (broken / "metadata.yaml").write_text("{[not: valid: yaml", encoding="utf-8")
    assert topic_signature(broken) is None

    not_a_mapping = tmp_path / "list"
    not_a_mapping.mkdir()
    (not_a_mapping / "metadata.yaml").write_text("- a\n- b\n", encoding="utf-8")
    assert topic_signature(not_a_mapping) is None
