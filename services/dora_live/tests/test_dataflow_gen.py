"""Dataflow generation: wiring, id sanitization, and the queue_size lint."""

import pytest
import yaml
from dora_live.dataflow_gen import (
    bridge_node_id,
    generate_dataflow,
    is_compressed_image,
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


def test_is_compressed_image():
    assert is_compressed_image("sensor_msgs/msg/CompressedImage")
    assert is_compressed_image("sensor_msgs/CompressedImage")
    assert not is_compressed_image("sensor_msgs/msg/Image")


def test_webrtc_node_taps_only_compressed_image():
    df = generate_dataflow(_manifest(), webrtc_env={"WEBRTC_PACKET_MAX": "1200"})
    webrtc = next(n for n in df["nodes"] if n["id"] == "webrtc")
    # ONLY the CompressedImage topic is an input (JointState is excluded).
    inputs = [k for k in webrtc["inputs"] if k.startswith("t__")]
    assert inputs == ["t__hsrb_hand_camera_image_raw_compressed"]
    assert webrtc["inputs"][inputs[0]]["queue_size"] == 1000
    assert webrtc["env"]["DORA_NODE_MODULE"] == "dora_live.nodes.webrtc"
    assert webrtc["env"]["DORA_LIVE_WEBRTC_PORT"] == "8007"  # default
    assert webrtc["env"]["WEBRTC_PACKET_MAX"] == "1200"  # passed through
    assert lint_queue_sizes(df) == []


def test_webrtc_env_port_override():
    df = generate_dataflow(_manifest(), webrtc_env={"DORA_LIVE_WEBRTC_PORT": "9099"})
    webrtc = next(n for n in df["nodes"] if n["id"] == "webrtc")
    assert webrtc["env"]["DORA_LIVE_WEBRTC_PORT"] == "9099"


def test_webrtc_node_always_present_even_without_cameras():
    # Something must always listen on the signaling port (nginx /webrtc/ 502s
    # otherwise); with no cameras the node has only its tick input and an
    # empty bus-topic list so /stream/start refuses honestly.
    m = LiveManifest(
        topics=[
            LiveTopic(name="/hsrb/joint_states", ros_type="sensor_msgs/msg/JointState")
        ]
    )
    df = generate_dataflow(m)
    webrtc = next(n for n in df["nodes"] if n["id"] == "webrtc")
    assert list(webrtc["inputs"]) == ["tick"]
    assert webrtc["env"]["DORA_LIVE_WEBRTC_TOPICS"] == ""


def test_token_collisions_deduped():
    from dora_live.dataflow_gen import unique_tokens

    tokens = unique_tokens(["/cam/left", "/cam_left", "/cam.left"])
    assert len(set(tokens.values())) == 3
    m = LiveManifest(
        topics=[
            LiveTopic(name="/cam/left", ros_type="std_msgs/msg/String"),
            LiveTopic(name="/cam_left", ros_type="std_msgs/msg/String"),
        ]
    )
    df = generate_dataflow(m)  # must not raise
    bridge_ids = [n["id"] for n in df["nodes"] if n["id"].startswith("bridge__")]
    assert len(bridge_ids) == len(set(bridge_ids)) == 2
