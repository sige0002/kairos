"""Unit tests for parsing the recorder's nested /record/metadata shape.

These pin the exact contract the recorder returns (manifest + rosbag2_metadata
+ a top-level recorder-computed ``bytes``) so the run row reflects reality:
topics with types, message_count, and the total recording size.
"""

from __future__ import annotations

from typing import Any

from api_orchestrator.runs import RunService


def _fields(meta: dict[str, Any]) -> dict[str, Any]:
    """Run the (static) metadata->fields mapping under test."""
    return RunService._metadata_to_fields(meta)


def test_start_time_metadata_has_topics_but_no_counts() -> None:
    """Pre-finalize: manifest topics (types null), rosbag2_metadata absent."""
    meta = {
        "run_id": "run_x",
        "manifest": {
            "topics": [
                {
                    "name": "/joint_states",
                    "type": None,
                    "qos": {
                        "reliability": "best_effort",
                        "durability": "volatile",
                        "depth": 1,
                    },
                }
            ],
            "compression": "none",
            "split": None,
            "ended_at": None,
        },
        "rosbag2_metadata": None,
    }
    fields = _fields(meta)
    assert [t.name for t in fields["topics"]] == ["/joint_states"]
    # Type is unresolved at start -> blank, not a KeyError.
    assert fields["topics"][0].type == ""
    assert fields["topics"][0].qos.reliability.value == "best_effort"
    # No counters yet (rosbag2_metadata is null until finalize).
    assert "message_count" not in fields
    assert "bytes" not in fields
    assert "ended_at" not in fields


def test_finalized_metadata_populates_counts_types_and_bytes() -> None:
    """Post-finalize: counts from rosbag2_metadata, bytes from top-level field."""
    meta = {
        "run_id": "run_x",
        "manifest": {
            "topics": [
                {"name": "/joint_states", "type": None, "qos": None},
                {"name": "/tf", "type": None, "qos": None},
            ],
            "compression": "zstd",
            "split": {"max_size_mb": 512, "max_duration_s": None},
            "ended_at": "2026-06-24T00:05:00.000Z",
        },
        "rosbag2_metadata": {
            "message_count": 1533,
            # files[].size is unreliable; the recorder reports total via `bytes`.
            "files": [{"path": "run_x_0.mcap"}, {"path": "run_x_1.mcap"}],
            "topics_with_message_count": [
                {
                    "topic_metadata": {
                        "name": "/joint_states",
                        "type": "sensor_msgs/msg/JointState",
                    },
                    "message_count": 1000,
                },
                {
                    "topic_metadata": {"name": "/tf", "type": "tf2_msgs/msg/TFMessage"},
                    "message_count": 533,
                },
            ],
        },
        # Recorder-computed total size (top-level), not sum(files[].size).
        "bytes": 9000000,
    }
    fields = _fields(meta)
    assert fields["message_count"] == 1533
    assert fields["bytes"] == 9000000  # top-level recorder-computed total
    assert fields["ended_at"] == "2026-06-24T00:05:00.000Z"
    assert fields["compression"].value == "zstd"
    assert fields["split"].max_size_mb == 512
    # Types backfilled from rosbag2_metadata.topics_with_message_count.
    by_name = {t.name: t.type for t in fields["topics"]}
    assert by_name == {
        "/joint_states": "sensor_msgs/msg/JointState",
        "/tf": "tf2_msgs/msg/TFMessage",
    }


def test_empty_metadata_leaves_fields_untouched() -> None:
    """A body with neither manifest nor rosbag2 yields no update fields."""
    assert _fields({"run_id": "run_x"}) == {}
    assert _fields({"manifest": None, "rosbag2_metadata": None}) == {}


def test_falls_back_to_rosbag_topics_without_manifest() -> None:
    """If the manifest has no topics, derive them from rosbag2_metadata."""
    meta = {
        "manifest": {"topics": []},
        "rosbag2_metadata": {
            "message_count": 5,
            "files": [{"path": "run_x_0.mcap"}],
            "topics_with_message_count": [
                {
                    "topic_metadata": {"name": "/tf", "type": "tf2_msgs/msg/TFMessage"},
                    "message_count": 5,
                }
            ],
        },
        "bytes": 42,
    }
    fields = _fields(meta)
    assert [t.name for t in fields["topics"]] == ["/tf"]
    assert fields["topics"][0].type == "tf2_msgs/msg/TFMessage"
    assert fields["bytes"] == 42
