"""Generate the dora dataflow for a live manifest.

Layout (cell-verified): one bridge node per topic (external events carry no
topic attribution; metadata on ``send_output`` does), plus fan-in consumer
nodes. Every node-to-node input carries an explicit ``queue_size`` — the dora
default queue drops bursty high-rate messages (report §4.3), so generation
fails closed if the manifest queue size is missing/invalid, and a unit test
lints the emitted graph.
"""

from __future__ import annotations

import re
from typing import Any

import yaml

from dora_live.bridge_logic import dora_type_name
from dora_live.manifest import LiveManifest

METRICS_TICK = "dora/timer/millis/1000"
PROBE_TICK = "dora/timer/millis/500"
TIMER_PREFIX = "dora/timer/"


def topic_token(topic: str) -> str:
    """Sanitize a ROS topic name into a dora node/input id fragment."""
    token = re.sub(r"[^a-z0-9_]", "_", topic.lower()).strip("_")
    return token or "root"


def bridge_node_id(topic: str) -> str:
    return f"bridge__{topic_token(topic)}"


def generate_dataflow(
    manifest: LiveManifest,
    *,
    python_bin: str = "/opt/venv/bin/python",
    common_env: dict[str, str] | None = None,
    control_url: str = "http://127.0.0.1:9601",
) -> dict[str, Any]:
    """Build the dataflow document (dict form; see :func:`to_yaml`)."""
    if manifest.queue_size < 1:
        raise ValueError(f"queue_size must be >= 1: {manifest.queue_size}")
    env = dict(common_env or {})

    nodes: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for t in manifest.topics:
        node_id = bridge_node_id(t.name)
        if node_id in seen_ids:
            raise ValueError(f"duplicate bridge node id {node_id} ({t.name})")
        seen_ids.add(node_id)
        nodes.append(
            {
                "id": node_id,
                "path": python_bin,
                "args": "-m dora_live.nodes.bridge",
                "env": {
                    **env,
                    "BRIDGE_TOPIC": t.name,
                    "BRIDGE_TYPE": dora_type_name(t.ros_type),
                    "BRIDGE_QOS": t.qos,
                    "BRIDGE_QOS_DEPTH": str(t.depth),
                },
                "outputs": ["out"],
            }
        )

    def fan_in_all() -> dict[str, Any]:
        # Both metrics and probe tap every topic: metrics needs universal
        # coverage, and the probe decodes on demand so the operator can pick
        # any topic without a dataflow restart (the graph stays static).
        return {
            f"t__{topic_token(t.name)}": {
                "source": f"{bridge_node_id(t.name)}/out",
                "queue_size": manifest.queue_size,
            }
            for t in manifest.topics
        }

    metrics_inputs = fan_in_all()
    metrics_inputs["tick"] = METRICS_TICK
    nodes.append(
        {
            "id": "metrics",
            "path": python_bin,
            "args": "-m dora_live.nodes.metrics",
            "env": {**env, "CONTROL_URL": control_url},
            "inputs": metrics_inputs,
        }
    )

    if manifest.topics:
        probe_inputs = fan_in_all()
        probe_inputs["tick"] = PROBE_TICK
        nodes.append(
            {
                "id": "probe",
                "path": python_bin,
                "args": "-m dora_live.nodes.probe",
                "env": {**env, "CONTROL_URL": control_url},
                "inputs": probe_inputs,
            }
        )
        nodes.append(
            {
                "id": "ai",
                "path": python_bin,
                "args": "-m dora_live.nodes.ai",
                "env": {**env, "CONTROL_URL": control_url},
                "inputs": fan_in_all(),
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
