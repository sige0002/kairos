"""Bridge node: one ROS 2 topic -> the dora dataflow.

Runs forever (until STOP): subscribes to ``BRIDGE_TOPIC`` via Ros2Context
(RustDDS) and forwards each message downstream with attribution metadata.
Unresolvable types arrive as ``RuntimeError`` values (lazy resolution,
cell-B verified); those are still forwarded as arrival events — Hz stays
measurable for unbridged topics, size/stamp do not.

Env: BRIDGE_TOPIC, BRIDGE_TYPE (``pkg/Type``), BRIDGE_QOS
(reliable|best_effort), BRIDGE_QOS_DEPTH, plus AMENT_PREFIX_PATH /
ROS_DOMAIN_ID consumed by dora itself.
"""

from __future__ import annotations

import os
import sys
import time

from dora_live.bridge_logic import classify_value, extract_stamp_ns


def log(*parts: object) -> None:
    print("[bridge]", *parts, file=sys.stderr, flush=True)


def main() -> int:
    # Heavy imports stay inside main() so unit tests import the module freely.
    import pyarrow as pa
    from dora import Node, Ros2Context, Ros2NodeOptions, Ros2QosPolicies

    topic = os.environ["BRIDGE_TOPIC"]
    ros_type = os.environ["BRIDGE_TYPE"]
    qos_name = os.environ.get("BRIDGE_QOS", "best_effort")
    depth = int(os.environ.get("BRIDGE_QOS_DEPTH", "30"))

    ctx = Ros2Context()
    ros2_node = ctx.new_node(
        f"live_{abs(hash(topic)) % 10_000}",
        "/kairos_live",
        Ros2NodeOptions(rosout=False),
    )
    qos = Ros2QosPolicies(
        reliable=(qos_name == "reliable"), keep_last=depth, max_blocking_time=0.1
    )
    sub = ros2_node.create_subscription(ros2_node.create_topic(topic, ros_type, qos))

    node = Node()
    node.merge_external_events(sub)
    log(topic, "subscribed", ros_type, qos_name)

    unbridged_reported = False
    while True:
        ev = node.next(timeout=1.0)
        if ev is None:
            continue
        kind = ev["kind"]
        if kind == "external":
            t_recv_ns = time.monotonic_ns()
            info = classify_value(ev["value"])
            meta = {
                "topic": topic,
                "ros_type": ros_type,
                "t_recv_ns": str(t_recv_ns),
                "bridged": "1" if info.bridged else "0",
            }
            if info.bridged:
                stamp_ns = extract_stamp_ns(ev["value"])
                meta["size"] = str(info.size_bytes)
                if stamp_ns is not None:
                    meta["stamp_ns"] = str(stamp_ns)
                node.send_output("out", ev["value"], meta)
            else:
                if not unbridged_reported:
                    log(topic, "UNBRIDGED (type unresolved):", info.error)
                    unbridged_reported = True
                meta["error"] = (info.error or "")[:200]
                node.send_output("out", pa.array([], type=pa.null()), meta)
        elif kind == "dora" and ev.get("type") == "STOP":
            log(topic, "STOP")
            break
    return 0


if __name__ == "__main__":
    sys.exit(main())
