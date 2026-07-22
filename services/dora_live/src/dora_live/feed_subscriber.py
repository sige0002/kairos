"""TopicSubscriber implementation fed by the dora dataflow.

Implements the same seam Protocol as topic_monitor's rclpy subscriber, so
``MonitorService`` (kairos_common.monitoring) runs unmodified on top of the
dora bridge. Samples arrive as HTTP batches pushed by the metrics dataflow
node (``POST /internal/samples``); graph discovery runs on the carried dora
patch's ``Ros2GraphWatcher`` (a bare RustDDS participant tracking SEDP
endpoint events — no rosout, no parameter services). If the installed dora
wheel lacks the patch, discovery falls back to the previous rclpy poller
with a loud warning (both are lazy-imported — unit tests never need ROS).

Honesty note: DDS ``message_lost`` events are an rclpy/RMW feature the RustDDS
bridge does not surface, so the lost sink never fires in dora_live mode —
``dds_samples_lost`` stays 0 by design and loss detection rests on the
``expected_hz`` shortfall floor. The snapshot marks ``source: dora_bridge``.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from typing import Any

from kairos_common.monitoring import Sample, TopicGraphEntry, publisher_qos_infos
from kairos_common.monitoring.models import QosInfo

logger = logging.getLogger(__name__)

DISCOVERY_PERIOD_S = 2.0


class DoraFeedSubscriber:
    """Sample source = dora metrics node pushes; discovery = DDS graph watch."""

    def __init__(
        self,
        *,
        topic_types: dict[str, str] | None = None,
        node_name: str = "dora_live_graph",
        enable_discovery: bool = True,
    ) -> None:
        # Which discovery backend actually runs: "dora_graph" (the carried
        # patch's RustDDS watcher), "rclpy" (fallback), or "none" (neither
        # importable / not started). Surfaced via /live/status for honesty.
        self.discovery_source = "none"
        self._sink: Callable[[Sample], None] | None = None
        self._lost_sink: Callable[[str, int], None] | None = None
        self._paused = False
        self._up = False
        self._topic_types = dict(topic_types or {})
        self._node_name = node_name
        self._enable_discovery = enable_discovery
        self._graph: list[TopicGraphEntry] = []
        self._publisher_qos: dict[str, list[QosInfo]] = {}
        self._graph_lock = threading.Lock()
        self._stop_evt = threading.Event()
        self._thread: threading.Thread | None = None
        # Liveness of the dataflow itself, reported by the supervisor; folded
        # into is_up() so /readyz reflects a dead `dora run`.
        self._dataflow_alive: Callable[[], bool] = lambda: True

    # -- TopicSubscriber protocol -------------------------------------------

    def set_sink(self, sink: Callable[[Sample], None]) -> None:
        self._sink = sink

    def set_lost_sink(self, sink: Callable[[str, int], None]) -> None:
        self._lost_sink = sink  # never fired (see module docstring)

    def start(self) -> None:
        self._paused = False
        self._up = True
        if self._enable_discovery and self._thread is None:
            self._stop_evt.clear()
            self._thread = threading.Thread(
                target=self._graph_loop, name="dora-live-graph", daemon=True
            )
            self._thread.start()

    def pause(self) -> None:
        self._paused = True

    def resume(self) -> None:
        self._paused = False

    def stop(self) -> None:
        self._up = False
        self._stop_evt.set()
        if self._thread is not None:
            self._thread.join(timeout=5.0)
            self._thread = None
        self.discovery_source = "none"

    def is_up(self) -> bool:
        return self._up and self._dataflow_alive()

    def discover_topics(self) -> list[TopicGraphEntry]:
        with self._graph_lock:
            return list(self._graph)

    def publisher_qos(self) -> dict[str, list[QosInfo]]:
        """Offered publisher QoS per topic (same poll as the graph snapshot).

        Feeds the supervisor's per-topic QoS resolution; empty until the first
        poll (the resolver's no-publisher fallback covers that window).
        """
        with self._graph_lock:
            return {k: list(v) for k, v in self._publisher_qos.items()}

    # -- dora_live wiring -----------------------------------------------------

    def set_dataflow_liveness(self, probe: Callable[[], bool]) -> None:
        self._dataflow_alive = probe

    def set_topic_types(self, topic_types: dict[str, str]) -> None:
        self._topic_types = dict(topic_types)

    def bridged_topics(self) -> set[str]:
        """Topics currently wired onto the live bus (manifest-derived)."""
        return set(self._topic_types)

    def ingest_batch(self, rows: list[dict[str, Any]]) -> int:
        """Feed one pushed batch; returns the number of samples delivered.

        Row shape (metrics node contract): ``{"topic": str, "recv_t": float,
        "size": int, "stamp_s": float|None, "bridged": bool}``. ``recv_t`` is
        CLOCK_MONOTONIC while ``header.stamp`` is epoch — the engine compares
        the two directly (``stamp_delay = recv_t - stamp_s``), so the stamp is
        shifted into the monotonic domain here; without this the delay is
        either discarded or garbage (review finding: 63-day "delays").
        """
        sink = self._sink
        if sink is None or self._paused:
            return 0
        # Epoch -> monotonic offset, computed per batch (sub-ms drift is far
        # below the stamp-quality thresholds this feeds).
        offset = time.time() - time.monotonic()
        delivered = 0
        for row in rows:
            topic = row["topic"]
            stamp_s = row.get("stamp_s")
            sink(
                Sample(
                    topic=topic,
                    type=self._topic_types.get(topic),
                    recv_t=float(row["recv_t"]),
                    size_bytes=int(row.get("size") or 0),
                    stamp_s=None if stamp_s is None else float(stamp_s) - offset,
                )
            )
            delivered += 1
        return delivered

    # -- discovery poller ------------------------------------------------------

    def _graph_loop(self) -> None:
        import os

        watcher = None
        mode = os.environ.get("DORA_LIVE_DISCOVERY", "").lower()
        if mode == "rclpy":
            # Operational escape hatch (and the honest A/B lever for load
            # comparisons): force the previous rclpy poller.
            logger.warning("DORA_LIVE_DISCOVERY=rclpy: using the rclpy poller")
        else:
            if mode:
                logger.warning(
                    "unknown DORA_LIVE_DISCOVERY=%r; using the dora graph watcher",
                    mode,
                )
            # Import and construction failures are DIFFERENT diagnoses: a
            # missing class means the wheel lacks the carried patch (rebuild
            # the image); a constructor error is environmental (e.g. DDS
            # participant creation failed — see the participant-index trap).
            watcher_cls = None
            try:
                from dora import Ros2GraphWatcher as watcher_cls  # noqa: N813
            except ImportError as exc:
                logger.error(
                    "dora Ros2GraphWatcher not importable (%s) — this dora "
                    "wheel lacks the carried graph-watcher patch; falling "
                    "back to the rclpy discovery poller",
                    exc,
                )
            if watcher_cls is not None:
                try:
                    watcher = watcher_cls()
                except Exception as exc:  # noqa: BLE001 - env failure, not wheel
                    logger.error(
                        "Ros2GraphWatcher creation failed (%s) — environmental "
                        "(DDS participant creation?); falling back to the "
                        "rclpy discovery poller",
                        exc,
                    )
        if watcher is None:
            self._graph_loop_rclpy()
            return
        self.discovery_source = "dora_graph"
        snapshot_failing = False
        try:
            while not self._stop_evt.wait(DISCOVERY_PERIOD_S):
                try:
                    rows = watcher.snapshot()
                except Exception:  # noqa: BLE001 - one bad poll, not fatal
                    if not snapshot_failing:
                        logger.exception(
                            "graph snapshot failed; keeping last graph "
                            "(silent until recovery)"
                        )
                        snapshot_failing = True
                    continue
                if snapshot_failing:
                    logger.info("graph snapshot recovered")
                    snapshot_failing = False
                entries, qos = entries_from_snapshot(rows)
                with self._graph_lock:
                    self._graph = entries
                    self._publisher_qos = qos
        finally:
            watcher.stop()

    def _graph_loop_rclpy(self) -> None:
        """Previous rclpy-node poller, kept as a loud-warning fallback only."""
        try:
            import rclpy
            from rclpy.node import Node
        except Exception:  # pragma: no cover - exercised only without ROS
            logger.warning("rclpy unavailable; discovery disabled")
            return
        self.discovery_source = "rclpy"
        context = rclpy.Context()
        rclpy.init(context=context)
        node = Node(self._node_name, context=context)
        try:
            while not self._stop_evt.wait(DISCOVERY_PERIOD_S):
                entries: list[TopicGraphEntry] = []
                qos: dict[str, list[QosInfo]] = {}
                for name, types in node.get_topic_names_and_types():
                    entries.append(
                        TopicGraphEntry(
                            name=name,
                            type=types[0] if types else None,
                            publisher_count=node.count_publishers(name),
                            subscriber_count=node.count_subscribers(name),
                        )
                    )
                    try:
                        qos[name] = publisher_qos_infos(node, name)
                    except Exception:  # noqa: BLE001 - one bad graph query, not fatal
                        qos[name] = []
                with self._graph_lock:
                    self._graph = entries
                    self._publisher_qos = qos
        finally:
            node.destroy_node()
            rclpy.shutdown(context=context)


def entries_from_snapshot(
    rows: list[tuple[str, str, int, int, list[tuple[str, str, int]]]],
) -> tuple[list[TopicGraphEntry], dict[str, list[QosInfo]]]:
    """Convert ``Ros2GraphWatcher.snapshot()`` rows to the graph-poll shape.

    Row: ``(name, type, publisher_count, subscriber_count,
    [(reliability, durability, depth), ...])`` — same information the rclpy
    poller produced, so ``resolve_subscription_qos`` and ``/topics`` see an
    identical world.
    """
    entries: list[TopicGraphEntry] = []
    qos: dict[str, list[QosInfo]] = {}
    for name, type_name, n_pub, n_sub, publishers in rows:
        entries.append(
            TopicGraphEntry(
                name=name,
                type=type_name or None,
                publisher_count=n_pub,
                subscriber_count=n_sub,
            )
        )
        qos[name] = [
            QosInfo(reliability=rel, durability=dur, depth=depth)
            for rel, dur, depth in publishers
        ]
    return entries, qos
