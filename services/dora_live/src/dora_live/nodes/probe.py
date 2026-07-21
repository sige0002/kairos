"""Probe dataflow node: on-demand field extraction over the whole bus.

Taps every bridged topic (static graph — no dataflow restart when the
operator picks a different topic) but decodes only what the control sidecar
reports active: each 500 ms tick it polls ``GET /internal/probe/active`` and
per message extracts the requested dotted fields (``POST
/internal/probe/values``, throttled to 20 Hz/topic) or introspects the
numeric field paths (``POST /internal/probe/fields``).
"""

from __future__ import annotations

import os
import sys
import time
from typing import Any

from dora_live.bridge_logic import classify_value
from dora_live.fieldpath import extract_value, iter_numeric_paths

_PUSH_MIN_INTERVAL_S = 1.0 / 20.0


def log(*parts: object) -> None:
    print("[probe]", *parts, file=sys.stderr, flush=True)


def decode_first(value: Any) -> dict | None:
    """Arrow struct array -> the first element as a nested dict."""
    try:
        rows = value.to_pylist()
    except Exception:
        return None
    if not rows or not isinstance(rows[0], dict):
        return None
    return rows[0]


def main() -> int:
    import httpx
    from dora import Node

    control_url = os.environ.get("CONTROL_URL", "http://127.0.0.1:9601").rstrip("/")
    client = httpx.Client(timeout=2.0)

    node = Node()
    active: dict[str, list[str]] = {}
    introspect: set[str] = set()
    last_push: dict[str, float] = {}

    def poll_active() -> None:
        nonlocal active, introspect
        try:
            data = client.get(f"{control_url}/internal/probe/active").json()
            active = data.get("topics", {})
            introspect = set(data.get("introspect", []))
        except Exception:
            pass  # keep the previous set; control may be restarting

    log("up")
    while True:
        ev = node.next(timeout=1.0)
        if ev is None:
            continue
        if ev["kind"] != "dora":
            continue
        if ev["type"] == "STOP":
            log("STOP")
            break
        if ev["type"] != "INPUT":
            continue
        if ev["id"] == "tick":
            poll_active()
            continue

        meta = ev.get("metadata") or {}
        topic = meta.get("topic")
        if not topic:
            continue
        wants_values = topic in active
        wants_fields = topic in introspect
        if not (wants_values or wants_fields):
            continue
        info = classify_value(ev["value"])
        if not info.bridged:
            if wants_fields:
                _post(
                    client,
                    f"{control_url}/internal/probe/fields",
                    {
                        "topic": topic,
                        "fields": [],
                        "reason": "type not bridged (no .msg on AMENT_PREFIX_PATH)",
                    },
                )
                introspect.discard(topic)
            continue
        decoded = decode_first(ev["value"])
        if decoded is None:
            continue
        if wants_fields:
            paths = list(iter_numeric_paths(decoded))
            _post(
                client,
                f"{control_url}/internal/probe/fields",
                {
                    "topic": topic,
                    "fields": paths,
                    "reason": None if paths else "no numeric fields",
                },
            )
            introspect.discard(topic)
        if wants_values:
            now = time.monotonic()
            if now - last_push.get(topic, 0.0) >= _PUSH_MIN_INTERVAL_S:
                last_push[topic] = now
                values = {f: extract_value(decoded, f) for f in active[topic]}
                _post(
                    client,
                    f"{control_url}/internal/probe/values",
                    {"topic": topic, "t": time.time(), "values": values},
                )
    return 0


def _post(client: Any, url: str, payload: dict) -> None:
    try:
        client.post(url, json=payload)
    except Exception:
        pass  # lossy-tolerant, same policy as the metrics feed


if __name__ == "__main__":
    sys.exit(main())
