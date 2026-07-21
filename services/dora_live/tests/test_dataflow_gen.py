"""Dataflow generation: wiring, id sanitization, and the queue_size lint."""

import pytest
import yaml
from dora_live.dataflow_gen import (
    bridge_node_id,
    generate_dataflow,
    lint_queue_sizes,
    to_yaml,
    topic_token,
)
from dora_live.manifest import LiveManifest, LiveTopic


def _manifest() -> LiveManifest:
    return LiveManifest(
        topics=[
            LiveTopic(
                name="/hsrb/joint_states",
                ros_type="sensor_msgs/msg/JointState",
                qos="best_effort",
                probe=True,
            ),
            LiveTopic(
                name="/hsrb/hand_camera/image_raw/compressed",
                ros_type="sensor_msgs/msg/CompressedImage",
                webrtc=True,
            ),
        ]
    )


def test_topic_token_sanitizes():
    assert topic_token("/hsrb/joint_states") == "hsrb_joint_states"
    assert "/" not in bridge_node_id("/a/b-c.d")


def test_generated_graph_wiring():
    df = generate_dataflow(_manifest(), common_env={"ROS_DOMAIN_ID": "1"})
    ids = [n["id"] for n in df["nodes"]]
    assert "bridge__hsrb_joint_states" in ids
    assert "metrics" in ids
    assert "probe" in ids
    assert "ai" in ids

    metrics = next(n for n in df["nodes"] if n["id"] == "metrics")
    # metrics and probe both tap every topic (probe decodes on demand,
    # so the graph never restarts on probe selection)
    assert len([k for k in metrics["inputs"] if k.startswith("t__")]) == 2
    probe = next(n for n in df["nodes"] if n["id"] == "probe")
    assert len([k for k in probe["inputs"] if k.startswith("t__")]) == 2

    bridge = next(n for n in df["nodes"] if n["id"] == "bridge__hsrb_joint_states")
    assert bridge["env"]["BRIDGE_TYPE"] == "sensor_msgs/JointState"
    assert bridge["env"]["ROS_DOMAIN_ID"] == "1"


def test_queue_size_lint_enforced():
    df = generate_dataflow(_manifest())
    assert lint_queue_sizes(df) == []
    # sabotage one input -> to_yaml must refuse
    metrics = next(n for n in df["nodes"] if n["id"] == "metrics")
    key = next(k for k in metrics["inputs"] if k.startswith("t__"))
    metrics["inputs"][key] = metrics["inputs"][key]["source"]
    with pytest.raises(ValueError, match="queue_size lint failed"):
        to_yaml(df)


def test_yaml_round_trip():
    text = to_yaml(generate_dataflow(_manifest()))
    doc = yaml.safe_load(text)
    assert {n["id"] for n in doc["nodes"]} >= {"metrics", "probe"}


def test_bad_queue_size_rejected():
    m = _manifest()
    m.queue_size = 0
    with pytest.raises(ValueError, match="queue_size"):
        generate_dataflow(m)
