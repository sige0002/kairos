"""Bridge node: one ROS 2 topic -> the live lanes, SELF-REPORTING.

Runs forever (until STOP): subscribes to ``BRIDGE_TOPIC`` via Ros2Context
(RustDDS) and, per message:

- accounts a metrics feed row locally; a background feeder thread POSTs
  batches to the control sidecar every 100 ms (``/internal/samples`` — the
  same contract the central metrics node used to feed). The ingest loop
  NEVER blocks on HTTP (review finding: a stalled control loop would freeze
  the video path and cluster recv_t stamps, distorting the reported Hz);
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
import threading
import time

from dora_live.bridge_logic import (
    classify_value,
    decode_first,
    extract_stamp_ns,
    feed_row,
)
from dora_live.fieldpath import extract_value, iter_numeric_paths

# Feeder cadence: rows flush every 100 ms (the delivery lag directly
# depresses the hz the monitor windows compute — a 1 s flush made hz sawtooth
# up to 20% low, review finding), probe-active polls every 5th cycle (500 ms,
# parity with the retired probe node's tick).
FLUSH_INTERVAL_S = 0.1
PROBE_POLL_CYCLES = 5
# Row-buffer hard cap (~10x a 100 ms burst at extreme rates): protects memory
# if control stalls; dropping rows undercounts Hz, so it logs once.
MAX_BUFFERED_ROWS = 5000
_PUSH_MIN_INTERVAL_S = 1.0 / 20.0


class ControlFeeder(threading.Thread):
    """Owns ALL HTTP to the control sidecar, off the ingest thread.

    The ingest loop must NEVER block on HTTP (review finding): a stalled
    control loop would freeze the video forwarding path of forward=1 bridges
    and cluster ``recv_t`` stamps — the act of reporting would distort the
    very Hz/gap numbers being reported. The loop only appends to the row
    buffer / probe-post queue and reads the polled probe state; this thread
    does the POSTs on its own clock.
    """

    def __init__(self, control_url: str, topic: str) -> None:
        super().__init__(name="bridge-feeder", daemon=True)
        self._url = control_url
        self._topic = topic
        self._lock = threading.Lock()
        self._rows: list[dict] = []
        self._probe_posts: list[tuple[str, dict]] = []
        self._stop_evt = threading.Event()
        self._post_failing = False
        self._overflow_logged = False
        # Read by the ingest loop (whole-list swap = GIL-atomic).
        self.active_fields: list[str] = []
        self._introspect = False

    # -- ingest-thread side (never blocks) ---------------------------------

    def add_row(self, row: dict) -> None:
        with self._lock:
            if len(self._rows) >= MAX_BUFFERED_ROWS:
                if not self._overflow_logged:
                    self._overflow_logged = True
                    log(self._topic, "feed buffer overflow — dropping rows")
                del self._rows[: len(self._rows) - MAX_BUFFERED_ROWS + 1]
            self._rows.append(row)

    def post_probe(self, path: str, payload: dict) -> None:
        with self._lock:
            self._probe_posts.append((path, payload))

    def take_introspect(self) -> bool:
        with self._lock:
            want, self._introspect = self._introspect, False
            return want

    def stop(self) -> None:
        self._stop_evt.set()
        self.join(timeout=3.0)

    # -- feeder-thread side -------------------------------------------------

    def run(self) -> None:  # pragma: no cover - thread glue; pieces unit-tested
        import httpx

        client = httpx.Client(timeout=2.0)
        cycle = 0
        while not self._stop_evt.wait(FLUSH_INTERVAL_S):
            cycle += 1
            self._flush(client)
            if cycle % PROBE_POLL_CYCLES == 0:
                self._poll_probe(client)
        self._flush(client)  # final drain

    def _flush(self, client: object) -> None:
        with self._lock:
            rows, self._rows = self._rows, []
            posts, self._probe_posts = self._probe_posts, []
        if rows:
            try:
                client.post(f"{self._url}/internal/samples", json={"rows": rows})
                if self._post_failing:
                    log(self._topic, "feed POST recovered")
                    self._post_failing = False
            except Exception as exc:  # noqa: BLE001 - lossy-tolerant feed
                if not self._post_failing:
                    log(self._topic, "feed POST failed (dropping until recovery):", exc)
                    self._post_failing = True
        for path, payload in posts:
            try:
                client.post(f"{self._url}{path}", json=payload)
            except Exception:  # noqa: BLE001 - lossy-tolerant, like the feed
                pass

    def _poll_probe(self, client: object) -> None:
        try:
            data = client.get(f"{self._url}/internal/probe/active").json()
            fields = list((data.get("topics") or {}).get(self._topic, []))
            introspect = self._topic in set(data.get("introspect") or [])
        except Exception:  # noqa: BLE001 - control may be restarting
            return  # keep the previous probe state
        with self._lock:
            self.active_fields = fields
            if introspect:
                self._introspect = True


def log(*parts: object) -> None:
    print("[bridge]", *parts, file=sys.stderr, flush=True)


def main() -> int:
    # Heavy imports stay inside main() so unit tests import the module freely.
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
    feeder = ControlFeeder(control_url, topic)
    feeder.start()
    log(topic, "subscribed", ros_type, qos_name, "forward" if forward else "no-fwd")

    want_introspect = False
    last_value_push = 0.0
    unbridged_reported = False
    while True:
        ev = node.next(timeout=1.0)
        if ev is None:
            continue
        kind = ev["kind"]
        if kind == "dora":
            if ev.get("type") == "STOP":
                log(topic, "STOP")
                break
            # The tick input is only the bench-proven event-loop wake source;
            # all HTTP runs on the feeder thread's own clock.
            continue
        if kind != "external":
            continue

        t_recv_ns = time.monotonic_ns()
        info = classify_value(ev["value"])
        stamp_ns = extract_stamp_ns(ev["value"]) if info.bridged else None
        feeder.add_row(feed_row(topic, t_recv_ns, info, stamp_ns))
        want_introspect = want_introspect or feeder.take_introspect()

        if not info.bridged:
            if not unbridged_reported:
                log(topic, "UNBRIDGED (type unresolved):", info.error)
                unbridged_reported = True
            if want_introspect:
                feeder.post_probe(
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
        active_fields = feeder.active_fields
        wants_values = bool(active_fields) and (
            time.monotonic() - last_value_push >= _PUSH_MIN_INTERVAL_S
        )
        if want_introspect or wants_values:
            decoded = decode_first(ev["value"])
            if decoded is not None:
                if want_introspect:
                    paths = list(iter_numeric_paths(decoded))
                    feeder.post_probe(
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
                    feeder.post_probe(
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
    feeder.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
