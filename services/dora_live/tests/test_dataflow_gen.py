"""Dataflow generation: wiring, id sanitization, and the queue_size lint."""

import json

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
            ),
            LiveTopic(
                name="/hsrb/hand_camera/image_raw/compressed",
                ros_type="sensor_msgs/msg/CompressedImage",
                video="image",
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
    assert "ai" not in ids  # removed by ruling 2026-07-22 (extension seam only)

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


def test_webrtc_node_taps_only_video_topics():
    df = generate_dataflow(_manifest(), webrtc_env={"WEBRTC_PACKET_MAX": "1200"})
    webrtc = next(n for n in df["nodes"] if n["id"] == "webrtc")
    # ONLY the topic with a resolved video codec is an input.
    inputs = [k for k in webrtc["inputs"] if k.startswith("t__")]
    assert inputs == ["t__hsrb_hand_camera_image_raw_compressed"]
    # Latest-wins lane: shallow queue (stale frames = decode waste + latency).
    assert webrtc["inputs"][inputs[0]]["queue_size"] == 2
    assert webrtc["env"]["DORA_NODE_MODULE"] == "dora_live.nodes.webrtc"
    assert webrtc["env"]["DORA_LIVE_WEBRTC_PORT"] == "8007"  # default
    assert webrtc["env"]["WEBRTC_PACKET_MAX"] == "1200"  # passed through
    assert json.loads(webrtc["env"]["DORA_LIVE_VIDEO_MAP"]) == {
        "/hsrb/hand_camera/image_raw/compressed": "image"
    }
    assert lint_queue_sizes(df) == []


def test_webrtc_video_map_carries_ffmpeg_codec():
    m = LiveManifest(
        topics=[
            LiveTopic(
                name="/cam/ffmpeg",
                ros_type="ffmpeg_image_transport_msgs/msg/FFMPEGPacket",
                video="ffmpeg",
            ),
        ]
    )
    df = generate_dataflow(m)
    webrtc = next(n for n in df["nodes"] if n["id"] == "webrtc")
    assert [k for k in webrtc["inputs"] if k.startswith("t__")] == ["t__cam_ffmpeg"]
    assert json.loads(webrtc["env"]["DORA_LIVE_VIDEO_MAP"]) == {"/cam/ffmpeg": "ffmpeg"}


def test_frames_node_taps_forwardable_codecs_only():
    m = LiveManifest(
        topics=[
            LiveTopic(name="/j", ros_type="sensor_msgs/msg/JointState"),
            LiveTopic(
                name="/cam/c",
                ros_type="sensor_msgs/msg/CompressedImage",
                video="image",
            ),
            LiveTopic(
                name="/cam/f",
                ros_type="ffmpeg_image_transport_msgs/msg/FFMPEGPacket",
                video="ffmpeg",
            ),
            LiveTopic(name="/cam/r", ros_type="sensor_msgs/msg/Image", video="raw"),
        ],
        frames_sample_hz=1.5,
    )
    df = generate_dataflow(m)
    frames = next(n for n in df["nodes"] if n["id"] == "frames")
    inputs = sorted(k for k in frames["inputs"] if k.startswith("t__"))
    # image + ffmpeg forward; raw is excluded (no robot-side re-encode).
    assert inputs == ["t__cam_c", "t__cam_f"]
    assert json.loads(frames["env"]["DORA_LIVE_FRAMES_MAP"]) == {
        "/cam/c": "image",
        "/cam/f": "ffmpeg",
    }
    assert frames["env"]["FRAMES_SAMPLE_HZ"] == "1.5"
    assert lint_queue_sizes(df) == []


def test_frames_node_absent_when_disabled_or_no_topics():
    m = _manifest()
    m.frames_enabled = False
    assert not any(n["id"] == "frames" for n in generate_dataflow(m)["nodes"])
    only_numeric = LiveManifest(
        topics=[LiveTopic(name="/j", ros_type="sensor_msgs/msg/JointState")]
    )
    assert not any(
        n["id"] == "frames" for n in generate_dataflow(only_numeric)["nodes"]
    )


def test_bridge_env_carries_durability():
    m = LiveManifest(
        topics=[
            LiveTopic(
                name="/tf_static",
                ros_type="tf2_msgs/msg/TFMessage",
                qos="reliable",
                durability="transient_local",
                depth=1,
            ),
        ]
    )
    df = generate_dataflow(m)
    bridge = next(n for n in df["nodes"] if n["id"].startswith("bridge__"))
    assert bridge["env"]["BRIDGE_QOS"] == "reliable"
    assert bridge["env"]["BRIDGE_QOS_DURABILITY"] == "transient_local"
    assert bridge["env"]["BRIDGE_QOS_DEPTH"] == "1"


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
    assert json.loads(webrtc["env"]["DORA_LIVE_VIDEO_MAP"]) == {}


def test_per_lane_queue_depths():
    df = generate_dataflow(_manifest())
    metrics = next(n for n in df["nodes"] if n["id"] == "metrics")
    probe = next(n for n in df["nodes"] if n["id"] == "probe")
    frames = next(n for n in df["nodes"] if n["id"] == "frames")
    m_key = next(k for k in metrics["inputs"] if k.startswith("t__"))
    p_key = next(k for k in probe["inputs"] if k.startswith("t__"))
    f_key = next(k for k in frames["inputs"] if k.startswith("t__"))
    # Counting lane deep; latest-wins lanes shallow.
    assert metrics["inputs"][m_key]["queue_size"] == 1000
    assert probe["inputs"][p_key]["queue_size"] == 4
    assert frames["inputs"][f_key]["queue_size"] == 2


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
