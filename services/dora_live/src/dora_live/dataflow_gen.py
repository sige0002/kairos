"""Generate the dora dataflow for a live manifest.

Layout (cell-verified): one bridge node per topic (external events carry no
topic attribution; metadata on ``send_output`` does), plus fan-in consumer
nodes. Every node-to-node input carries an explicit ``queue_size`` — the dora
default queue drops bursty high-rate messages (report §4.3), so generation
fails closed if the manifest queue size is missing/invalid, and a unit test
lints the emitted graph.
"""

from __future__ import annotations

import json
import re
from typing import Any

import yaml

from dora_live.bridge_logic import dora_type_name
from dora_live.frames_lane import FRAMES_CODECS
from dora_live.manifest import LiveManifest

METRICS_TICK = "dora/timer/millis/1000"
# Feed flush tick: the metrics node ships sample batches to the control app on
# this tick, and the delivery lag directly depresses the hz the monitor windows
# compute (review finding: a 1 s flush made hz sawtooth up to 20% low). 100 ms
# keeps the bias under ~2% on the default 5 s window at negligible POST cost.
FEED_TICK = "dora/timer/millis/100"
PROBE_TICK = "dora/timer/millis/500"
TIMER_PREFIX = "dora/timer/"

DEFAULT_WEBRTC_PORT = "8007"
# WebRTC node env keys the supervisor passes through from the container env.
WEBRTC_ENV_KEYS = ("DORA_LIVE_WEBRTC_PORT", "WEBRTC_PACKET_MAX", "WEBRTC_KEEP_IPV6")


def topic_token(topic: str) -> str:
    """Sanitize a ROS topic name into a dora node/input id fragment."""
    token = re.sub(r"[^a-z0-9_]", "_", topic.lower()).strip("_")
    return token or "root"


def unique_tokens(topics: list[str]) -> dict[str, str]:
    """Map each topic to a collision-free token.

    Sanitization can collide (``/cam/left`` and ``/cam_left`` both become
    ``cam_left``); a numeric suffix disambiguates instead of refusing the
    whole manifest (review finding: the ValueError killed supervision).
    """
    mapping: dict[str, str] = {}
    used: set[str] = set()
    for topic in topics:
        token = topic_token(topic)
        candidate, n = token, 2
        while candidate in used:
            candidate = f"{token}_{n}"
            n += 1
        used.add(candidate)
        mapping[topic] = candidate
    return mapping


def bridge_node_id(topic: str) -> str:
    return f"bridge__{topic_token(topic)}"


def generate_dataflow(
    manifest: LiveManifest,
    *,
    node_launcher: str = "/run_node.sh",
    common_env: dict[str, str] | None = None,
    control_url: str = "http://127.0.0.1:9601",
    webrtc_env: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Build the dataflow document (dict form; see :func:`to_yaml`).

    Nodes launch through ``node_launcher`` (a plain shell wrapper that execs
    the venv python on ``DORA_NODE_MODULE``): dora runs ``*.py`` node paths
    with the system python3, which lacks the dora wheel — the wrapper is the
    bench-proven bypass.

    The ``webrtc`` node taps exactly the topics whose manifest entry carries a
    ``video`` codec (their topic->codec map travels as ``DORA_LIVE_VIDEO_MAP``).
    ``webrtc_env`` supplies its pass-through env (:data:`WEBRTC_ENV_KEYS`);
    ``DORA_LIVE_WEBRTC_PORT`` defaults to :data:`DEFAULT_WEBRTC_PORT`.
    """
    if manifest.queue_size < 1:
        raise ValueError(f"queue_size must be >= 1: {manifest.queue_size}")
    env = dict(common_env or {})

    tokens = unique_tokens([t.name for t in manifest.topics])

    nodes: list[dict[str, Any]] = []
    for t in manifest.topics:
        node_id = f"bridge__{tokens[t.name]}"
        nodes.append(
            {
                "id": node_id,
                "path": node_launcher,
                "env": {
                    **env,
                    "DORA_NODE_MODULE": "dora_live.nodes.bridge",
                    "BRIDGE_TOPIC": t.name,
                    "BRIDGE_TYPE": dora_type_name(t.ros_type),
                    "BRIDGE_QOS": t.qos,
                    "BRIDGE_QOS_DURABILITY": t.durability,
                    "BRIDGE_QOS_DEPTH": str(t.depth),
                },
                # Bench-proven: bridges keep a timer input so the event loop
                # always has a wake source even before DDS traffic arrives.
                "inputs": {"tick": METRICS_TICK},
                "outputs": ["out"],
            }
        )

    def fan_in_all() -> dict[str, Any]:
        # Both metrics and probe tap every topic: metrics needs universal
        # coverage, and the probe decodes on demand so the operator can pick
        # any topic without a dataflow restart (the graph stays static).
        return {
            f"t__{tokens[t.name]}": {
                "source": f"bridge__{tokens[t.name]}/out",
                "queue_size": manifest.queue_size,
            }
            for t in manifest.topics
        }

    metrics_inputs = fan_in_all()
    metrics_inputs["tick"] = FEED_TICK
    nodes.append(
        {
            "id": "metrics",
            "path": node_launcher,
            "env": {
                **env,
                "DORA_NODE_MODULE": "dora_live.nodes.metrics",
                "CONTROL_URL": control_url,
            },
            "inputs": metrics_inputs,
        }
    )

    if manifest.topics:
        probe_inputs = fan_in_all()
        probe_inputs["tick"] = PROBE_TICK
        nodes.append(
            {
                "id": "probe",
                "path": node_launcher,
                "env": {
                    **env,
                    "DORA_NODE_MODULE": "dora_live.nodes.probe",
                    "CONTROL_URL": control_url,
                },
                "inputs": probe_inputs,
            }
        )

    # Live-frames lane: decimated compressed payloads -> the control store,
    # for LAN consumers to pull (future off-robot image analysis). Taps only
    # the codecs the lane forwards (image / ffmpeg-keyframes; raw excluded —
    # see frames_lane). Emitted only when enabled and something qualifies.
    frames_topics = [t for t in manifest.topics if t.video in FRAMES_CODECS]
    if manifest.frames_enabled and frames_topics:
        frames_inputs: dict[str, Any] = {
            f"t__{tokens[t.name]}": {
                "source": f"bridge__{tokens[t.name]}/out",
                "queue_size": manifest.queue_size,
            }
            for t in frames_topics
        }
        frames_inputs["tick"] = METRICS_TICK
        nodes.append(
            {
                "id": "frames",
                "path": node_launcher,
                "env": {
                    **env,
                    "DORA_NODE_MODULE": "dora_live.nodes.frames",
                    "CONTROL_URL": control_url,
                    "DORA_LIVE_FRAMES_MAP": json.dumps(
                        {t.name: t.video for t in frames_topics}, sort_keys=True
                    ),
                    "FRAMES_SAMPLE_HZ": str(manifest.frames_sample_hz),
                },
                "inputs": frames_inputs,
            }
        )

    # WebRTC lane: taps ONLY topics with a resolved video codec (manifest
    # ``video`` — config rules over type defaults, see live_config; media
    # closes inside the node). The node is emitted even with ZERO camera
    # topics: something must always listen on the signaling port, or nginx
    # /webrtc/ 502s during discovery settle and on camera-less robots (review
    # finding). DORA_LIVE_VIDEO_MAP tells the node how to decode each topic
    # and lets the signaling app reject start requests for topics that are
    # not on the bus instead of streaming silent black.
    video_topics = [t for t in manifest.topics if t.video]
    webrtc_inputs: dict[str, Any] = {
        f"t__{tokens[t.name]}": {
            "source": f"bridge__{tokens[t.name]}/out",
            "queue_size": manifest.queue_size,
        }
        for t in video_topics
    }
    webrtc_inputs["tick"] = METRICS_TICK
    webrtc_node_env = {
        **env,
        "DORA_NODE_MODULE": "dora_live.nodes.webrtc",
        "DORA_LIVE_VIDEO_MAP": json.dumps(
            {t.name: t.video for t in video_topics}, sort_keys=True
        ),
        **(webrtc_env or {}),
    }
    webrtc_node_env.setdefault("DORA_LIVE_WEBRTC_PORT", DEFAULT_WEBRTC_PORT)
    nodes.append(
        {
            "id": "webrtc",
            "path": node_launcher,
            "env": webrtc_node_env,
            "inputs": webrtc_inputs,
        }
    )

    return {"nodes": nodes}


def lint_queue_sizes(dataflow: dict[str, Any]) -> list[str]:
    """Return violations: node-to-node inputs missing an explicit queue_size."""
    problems: list[str] = []
    for node in dataflow.get("nodes", []):
        for name, ref in (node.get("inputs") or {}).items():
            if isinstance(ref, str):
                if ref.startswith(TIMER_PREFIX):
                    continue
                problems.append(f"{node['id']}.{name}: plain ref without queue_size")
            elif isinstance(ref, dict):
                if not isinstance(ref.get("queue_size"), int):
                    problems.append(f"{node['id']}.{name}: missing queue_size")
    return problems


def to_yaml(dataflow: dict[str, Any]) -> str:
    problems = lint_queue_sizes(dataflow)
    if problems:
        raise ValueError("queue_size lint failed: " + "; ".join(problems))
    return yaml.safe_dump(dataflow, sort_keys=False, allow_unicode=True)
