"""Bridge node: one ROS 2 topic -> the live lanes, SELF-REPORTING.

Runs forever (until STOP): subscribes to ``BRIDGE_TOPIC`` via Ros2Context
(RustDDS) and, per message:

- accounts a metrics feed row locally and POSTs batches straight to the
  control sidecar on the 100 ms flush tick (``/internal/samples`` — the same
  contract the central metrics node used to feed);
- serves the probe contract for ITS OWN topic (polls
  ``/internal/probe/active`` on a ~1 s cadence; when active, decodes and
  pushes values at <=20 Hz, introspects fields on demand);
- forwards the Arrow payload downstream ONLY when the topic is on a payload
  lane (``BRIDGE_FORWARD=1`` — video/frames topics).

WHY self-reporting: central metrics/probe consumer nodes tapped EVERY topic,
so at field scale (29 topics, ~1000 msg/s) every message paid dora-daemon
routing + a Python event wakeup in each consumer — the dominant container
CPU. The bridge already touches every message; reporting from here removes
the whole per-message fan-in for non-camera topics (their bridges do not
``send_output`` at all).

Type resolution stays lazy (cell-B): unresolvable types arrive as
RuntimeError values; their arrivals still produce feed rows (Hz measurable,
size/stamp absent) and an honest probe-fields reason.

Env: BRIDGE_TOPIC, BRIDGE_TYPE (``pkg/Type``), BRIDGE_QOS
(reliable|best_effort), BRIDGE_QOS_DURABILITY (volatile|transient_local),
BRIDGE_QOS_DEPTH, BRIDGE_FORWARD (0|1), CONTROL_URL, plus
AMENT_PREFIX_PATH / ROS_DOMAIN_ID consumed by dora itself.
"""

from __future__ import annotations

import os
import sys
import time

from dora_live.bridge_logic import (
    FLUSH_MAX_ROWS,
    classify_value,
    decode_first,
    extract_stamp_ns,
    feed_row,
)
from dora_live.fieldpath import extract_value, iter_numeric_paths

# Poll /internal/probe/active every N flush ticks (N x 100 ms ~= 1 s).
PROBE_POLL_TICKS = 10
_PUSH_MIN_INTERVAL_S = 1.0 / 20.0


def log(*parts: object) -> None:
    print("[bridge]", *parts, file=sys.stderr, flush=True)


def main() -> int:
    # Heavy imports stay inside main() so unit tests import the module freely.
    import httpx
    from dora import Node, Ros2Context, Ros2NodeOptions, Ros2QosPolicies

    topic = os.environ["BRIDGE_TOPIC"]
    ros_type = os.environ["BRIDGE_TYPE"]
    qos_name = os.environ.get("BRIDGE_QOS", "best_effort")
    durability_name = os.environ.get("BRIDGE_QOS_DURABILITY", "volatile")
    depth = int(os.environ.get("BRIDGE_QOS_DEPTH", "30"))
    forward = os.environ.get("BRIDGE_FORWARD", "1") == "1"
    control_url = os.environ.get("CONTROL_URL", "http://127.0.0.1:9601").rstrip("/")

    ctx = Ros2Context()
    ros2_node = ctx.new_node(
        f"live_{abs(hash(topic)) % 10_000}",
        "/kairos_live",
        Ros2NodeOptions(rosout=False),
    )
    qos_kwargs: dict = {
        "reliable": qos_name == "reliable",
        "keep_last": depth,
        "max_blocking_time": 0.1,
    }
    if durability_name == "transient_local":
        # Durability is best-effort against the pinned dora API: fall back to
        # the (volatile) default rather than dying — a transient_local
        # subscription is an optimisation (receive latched history), never a
        # correctness requirement for the live lanes.
        try:
            from dora import Ros2Durability

            qos_kwargs["durability"] = Ros2Durability.TransientLocal
        except (ImportError, AttributeError) as exc:
            log(topic, "durability transient_local unsupported by dora:", exc)
    try:
        qos = Ros2QosPolicies(**qos_kwargs)
    except TypeError as exc:
        if "durability" not in qos_kwargs:
            raise
        log(topic, "durability kwarg rejected by dora; using volatile:", exc)
        qos_kwargs.pop("durability")
        qos = Ros2QosPolicies(**qos_kwargs)
    sub = ros2_node.create_subscription(ros2_node.create_topic(topic, ros_type, qos))

    node = Node()
    node.merge_external_events(sub)
    client = httpx.Client(timeout=2.0)
    log(topic, "subscribed", ros_type, qos_name, "forward" if forward else "no-fwd")

    batch: list[dict] = []
    post_failing = False

    def flush() -> None:
        nonlocal post_failing
        if not batch:
            return
        try:
            client.post(f"{control_url}/internal/samples", json={"rows": batch})
            if post_failing:
                log(topic, "feed POST recovered")
                post_failing = False
        except Exception as exc:  # noqa: BLE001 - lossy-tolerant feed
            if not post_failing:
                log(topic, "feed POST failed (dropping until recovery):", exc)
                post_failing = True
        finally:
            batch.clear()

    active_fields: list[str] = []
    want_introspect = False
    last_value_push = 0.0
    tick_count = 0

    def poll_probe() -> None:
        nonlocal active_fields, want_introspect
        try:
            data = client.get(f"{control_url}/internal/probe/active").json()
            active_fields = list((data.get("topics") or {}).get(topic, []))
            want_introspect = topic in set(data.get("introspect") or [])
        except Exception:  # noqa: BLE001 - control may be restarting
            pass  # keep the previous probe state

    def post_probe(path: str, payload: dict) -> None:
        try:
            client.post(f"{control_url}{path}", json=payload)
        except Exception:  # noqa: BLE001 - lossy-tolerant, like the feed
            pass

    unbridged_reported = False
    while True:
        ev = node.next(timeout=1.0)
        if ev is None:
            flush()
            continue
        kind = ev["kind"]
        if kind == "dora":
            if ev.get("type") == "STOP":
                flush()
                log(topic, "STOP")
                break
            if ev.get("type") == "INPUT" and ev.get("id") == "tick":
                flush()
                tick_count += 1
                if tick_count % PROBE_POLL_TICKS == 0:
                    poll_probe()
            continue
        if kind != "external":
            continue

        t_recv_ns = time.monotonic_ns()
        info = classify_value(ev["value"])
        stamp_ns = extract_stamp_ns(ev["value"]) if info.bridged else None
        batch.append(feed_row(topic, t_recv_ns, info, stamp_ns))
        if len(batch) >= FLUSH_MAX_ROWS:
            flush()

        if not info.bridged:
            if not unbridged_reported:
                log(topic, "UNBRIDGED (type unresolved):", info.error)
                unbridged_reported = True
            if want_introspect:
                post_probe(
                    "/internal/probe/fields",
                    {
                        "topic": topic,
                        "fields": [],
                        "reason": "type not bridged (no .msg on AMENT_PREFIX_PATH)",
                    },
                )
                want_introspect = False
            continue

        # Probe for THIS topic only; the expensive decode runs solely behind
        # the introspect flag / active-fields + 20 Hz throttle.
        wants_values = bool(active_fields) and (
            time.monotonic() - last_value_push >= _PUSH_MIN_INTERVAL_S
        )
        if want_introspect or wants_values:
            decoded = decode_first(ev["value"])
            if decoded is not None:
                if want_introspect:
                    paths = list(iter_numeric_paths(decoded))
                    post_probe(
                        "/internal/probe/fields",
                        {
                            "topic": topic,
                            "fields": paths,
                            "reason": None if paths else "no numeric fields",
                        },
                    )
                    want_introspect = False
                if wants_values:
                    last_value_push = time.monotonic()
                    values = {f: extract_value(decoded, f) for f in active_fields}
                    post_probe(
                        "/internal/probe/values",
                        {"topic": topic, "t": time.time(), "values": values},
                    )

        if forward:
            node.send_output(
                "out",
                ev["value"],
                {
                    "topic": topic,
                    "ros_type": ros_type,
                    "t_recv_ns": str(t_recv_ns),
                    "bridged": "1",
                    "size": str(info.size_bytes),
                    **({"stamp_ns": str(stamp_ns)} if stamp_ns is not None else {}),
                },
            )
    return 0


if __name__ == "__main__":
    sys.exit(main())
