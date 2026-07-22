"""live_ingest node: ALL feed-only topics in ONE process / ONE DDS participant.

The per-topic bridge fleet was the cost floor (measured: ~3%/bridge and ~90
threads each, x26 feed-only topics — plus the DDS participant-index space).
This node hangs N ``Ros2MetricsSubscription``s (the carried dora patch; topic
identity lives on the OBJECT, so no per-event attribution is needed) off ONE
``Ros2Context``:

    live_ingest
    ├─ metrics_subscription(topic_1)   # Rust-side counting, 100 ms drains
    ├─ ...
    └─ metrics_subscription(topic_N)

One feeder thread drains them all and ships ONE ``/internal/samples`` POST
per cycle; probe stays on-demand per topic via the tap slot (payload is
materialised only while the operator watches). Video topics are NOT here —
they keep their per-topic forwarding bridges (payload lanes to webrtc/frames).

Env: INGEST_TOPICS (JSON: topic -> {type, qos, durability, depth}),
CONTROL_URL, plus AMENT_PREFIX_PATH / ROS_DOMAIN_ID consumed by dora.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time

from dora_live.bridge_logic import decode_first, feed_row_from_tuple
from dora_live.fieldpath import extract_value, iter_numeric_paths
from dora_live.nodes.bridge import (
    FLUSH_INTERVAL_S,
    MAX_BUFFERED_ROWS,
    PROBE_POLL_CYCLES,
    build_ros2_qos,
)


def log(*parts: object) -> None:
    print("[ingest]", *parts, file=sys.stderr, flush=True)


class IngestFeeder(threading.Thread):
    """Drains every metrics subscription and owns ALL control-sidecar HTTP.

    Same never-block-the-node discipline as the bridge's ControlFeeder, but
    one instance covers the whole feed-only topic set: one samples POST per
    100 ms cycle, one probe-active poll per 500 ms, per-topic tap slots.
    """

    def __init__(self, control_url: str, subs: dict[str, object]) -> None:
        super().__init__(name="ingest-feeder", daemon=True)
        self._url = control_url
        self._subs = subs
        self._stop_evt = threading.Event()
        self._post_failing = False
        self._active: dict[str, list[str]] = {}
        self._introspect: set[str] = set()
        self._tapped: set[str] = set()
        self._rust_dropped: dict[str, int] = {}
        self._drain_failed: set[str] = set()

    def stop(self) -> None:
        self._stop_evt.set()
        self.join(timeout=3.0)

    def run(self) -> None:  # pragma: no cover - thread glue; pieces unit-tested
        import httpx

        client = httpx.Client(timeout=2.0)
        cycle = 0
        while not self._stop_evt.wait(FLUSH_INTERVAL_S):
            cycle += 1
            self._cycle(client, poll_probe=cycle % PROBE_POLL_CYCLES == 0)
        self._cycle(client, poll_probe=False)  # final drain

    # -- one cycle (testable with a fake client/subs) -----------------------

    def _cycle(self, client: object, *, poll_probe: bool) -> None:
        rows: list[dict] = []
        unresolved: set[str] = set()
        for topic, sub in self._subs.items():
            try:
                samples = sub.drain()  # type: ignore[attr-defined]
                dropped = sub.dropped()  # type: ignore[attr-defined]
            except Exception as exc:  # noqa: BLE001 - never kill the feeder
                if topic not in self._drain_failed:
                    self._drain_failed.add(topic)
                    log(topic, "drain failed (topic dark until recovery):", exc)
                continue
            self._drain_failed.discard(topic)
            if dropped > self._rust_dropped.get(topic, 0):
                log(
                    topic,
                    "rust ring dropped",
                    dropped - self._rust_dropped.get(topic, 0),
                )
                self._rust_dropped[topic] = dropped
            if samples:
                if not any(s_[3] for s_ in samples):
                    unresolved.add(topic)
                rows.extend(feed_row_from_tuple(topic, s_) for s_ in samples)
        if len(rows) > MAX_BUFFERED_ROWS:
            del rows[: len(rows) - MAX_BUFFERED_ROWS]
        if rows:
            self._post(client, "/internal/samples", {"rows": rows})
        if poll_probe:
            self._poll_probe(client)
        self._serve_probe(client, unresolved)

    def _post(self, client: object, path: str, payload: dict) -> None:
        try:
            client.post(f"{self._url}{path}", json=payload)  # type: ignore[attr-defined]
            if path == "/internal/samples" and self._post_failing:
                log("feed POST recovered")
                self._post_failing = False
        except Exception as exc:  # noqa: BLE001 - lossy-tolerant feed
            if path == "/internal/samples" and not self._post_failing:
                log("feed POST failed (dropping until recovery):", exc)
                self._post_failing = True

    def _poll_probe(self, client: object) -> None:
        try:
            data = client.get(f"{self._url}/internal/probe/active").json()  # type: ignore[attr-defined]
        except Exception:  # noqa: BLE001 - control may be restarting
            return  # keep previous probe state
        self._active = {
            t: list(f) for t, f in (data.get("topics") or {}).items() if t in self._subs
        }
        self._introspect = {t for t in data.get("introspect") or [] if t in self._subs}
        want = set(self._active) | self._introspect
        for topic in want - self._tapped:
            self._set_tap(topic, True)
        for topic in self._tapped - want:
            self._set_tap(topic, False)

    def _set_tap(self, topic: str, enabled: bool) -> None:
        try:
            self._subs[topic].set_tap(enabled)  # type: ignore[attr-defined]
            (self._tapped.add if enabled else self._tapped.discard)(topic)
        except Exception as exc:  # noqa: BLE001
            log(topic, "set_tap failed:", exc)

    def _serve_probe(self, client: object, unresolved: set[str]) -> None:
        # Honest answer for unresolved types (parity with the bridge path).
        for topic in list(self._introspect & unresolved):
            self._post(
                client,
                "/internal/probe/fields",
                {
                    "topic": topic,
                    "fields": [],
                    "reason": "type not bridged (no .msg on AMENT_PREFIX_PATH)",
                },
            )
            self._introspect.discard(topic)
        for topic in list(self._tapped):
            try:
                value = self._subs[topic].take_latest()  # type: ignore[attr-defined]
            except Exception:  # noqa: BLE001
                continue
            if value is None:
                continue
            decoded = decode_first(value)
            if decoded is None:
                continue
            if topic in self._introspect:
                paths = list(iter_numeric_paths(decoded))
                self._post(
                    client,
                    "/internal/probe/fields",
                    {
                        "topic": topic,
                        "fields": paths,
                        "reason": None if paths else "no numeric fields",
                    },
                )
                self._introspect.discard(topic)
            fields = self._active.get(topic) or []
            if fields:
                values = {f: extract_value(decoded, f) for f in fields}
                self._post(
                    client,
                    "/internal/probe/values",
                    {"topic": topic, "t": time.time(), "values": values},
                )


def main() -> int:
    from dora import Node, Ros2Context, Ros2NodeOptions

    topics: dict[str, dict] = json.loads(os.environ["INGEST_TOPICS"])
    control_url = os.environ.get("CONTROL_URL", "http://127.0.0.1:9601").rstrip("/")

    ctx = Ros2Context()
    ros2_node = ctx.new_node(
        "live_ingest", "/kairos_live", Ros2NodeOptions(rosout=False)
    )
    if not hasattr(ros2_node, "create_metrics_subscription"):
        # The carried dora patch is a build-time guarantee of this image; a
        # wheel without it means a broken build — fail loudly, never half-run.
        raise RuntimeError(
            "dora build lacks create_metrics_subscription (kairos patch missing)"
        )

    subs: dict[str, object] = {}
    for topic, cfg in topics.items():
        qos = build_ros2_qos(cfg["qos"], cfg["durability"], int(cfg["depth"]), topic)
        subs[topic] = ros2_node.create_metrics_subscription(
            ros2_node.create_topic(topic, cfg["type"], qos), qos
        )
    log(f"up; {len(subs)} metrics subscriptions on ONE participant")

    node = Node()
    feeder = IngestFeeder(control_url, subs)
    feeder.start()
    while True:
        ev = node.next(timeout=1.0)
        if ev is None:
            continue
        if ev["kind"] == "dora" and ev.get("type") == "STOP":
            log("STOP")
            break
    feeder.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
