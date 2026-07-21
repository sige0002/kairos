"""Realtime analysis dataflow node (Phase 2 lane, demo-grade detectors).

Taps every bridged topic; runs the detectors from
:mod:`dora_live.detectors` and POSTs findings to the control sidecar
(``/internal/ai/events``). Which detectors run comes from
``DORA_LIVE_AI_DETECTORS`` (comma list; default all).
"""

from __future__ import annotations

import os
import sys
import time

from dora_live.bridge_logic import classify_value
from dora_live.detectors import JointVelocityDetector, StampLagDetector
from dora_live.nodes.probe import decode_first


def log(*parts: object) -> None:
    print("[ai]", *parts, file=sys.stderr, flush=True)


def main() -> int:
    import httpx
    from dora import Node

    control_url = os.environ.get("CONTROL_URL", "http://127.0.0.1:9601").rstrip("/")
    endpoint = f"{control_url}/internal/ai/events"
    enabled = set(
        (os.environ.get("DORA_LIVE_AI_DETECTORS") or "joint_velocity,stamp_lag")
        .replace(" ", "")
        .split(",")
    )
    client = httpx.Client(timeout=2.0)

    joint = JointVelocityDetector() if "joint_velocity" in enabled else None
    stamp = StampLagDetector() if "stamp_lag" in enabled else None
    node = Node()
    log("up; detectors:", sorted(enabled))

    while True:
        ev = node.next(timeout=1.0)
        if ev is None:
            continue
        if ev["kind"] != "dora":
            continue
        if ev["type"] == "STOP":
            log("STOP")
            break
        if ev["type"] != "INPUT" or ev["id"] == "tick":
            continue

        meta = ev.get("metadata") or {}
        topic = meta.get("topic")
        if not topic:
            continue
        wall_t = time.time()
        events = []

        if stamp is not None:
            stamp_ns = meta.get("stamp_ns")
            stamp_s = int(stamp_ns) / 1e9 if stamp_ns else None
            found = stamp.on_sample(topic, stamp_s, wall_t)
            if found:
                events.append(found)

        if joint is not None and "JointState" in (meta.get("ros_type") or ""):
            info = classify_value(ev["value"])
            if info.bridged:
                decoded = decode_first(ev["value"])
                if decoded is not None:
                    found = joint.on_message(topic, decoded, wall_t)
                    if found:
                        events.append(found)

        for event in events:
            try:
                client.post(endpoint, json=event.as_dict())
            except Exception:
                pass  # lossy-tolerant, same policy as the other feeds
    return 0


if __name__ == "__main__":
    sys.exit(main())
