"""TopicSubscriber implementation fed by the dora dataflow.

Implements the same seam Protocol as topic_monitor's rclpy subscriber, so
``MonitorService`` (kairos_common.monitoring) runs unmodified on top of the
dora bridge. Samples arrive as HTTP batches pushed by the metrics dataflow
node (``POST /internal/samples``); graph discovery runs on a subscription-free
rclpy poller thread (rclpy is lazy-imported — unit tests never need ROS).

Honesty note: DDS ``message_lost`` events are an rclpy/RMW feature the RustDDS
bridge does not surface, so the lost sink never fires in dora_live mode —
``dds_samples_lost`` stays 0 by design and loss detection rests on the
``expected_hz`` shortfall floor. The snapshot marks ``source: dora_bridge``.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from typing import Any

from kairos_common.monitoring import Sample, TopicGraphEntry

logger = logging.getLogger(__name__)

DISCOVERY_PERIOD_S = 2.0


class DoraFeedSubscriber:
    """Sample source = dora metrics node pushes; discovery = rclpy graph poll."""

    def __init__(
        self,
        *,
        topic_types: dict[str, str] | None = None,
        node_name: str = "dora_live_graph",
        enable_rclpy: bool = True,
    ) -> None:
        self._sink: Callable[[Sample], None] | None = None
        self._lost_sink: Callable[[str, int], None] | None = None
        self._paused = False
        self._up = False
        self._topic_types = dict(topic_types or {})
        self._node_name = node_name
        self._enable_rclpy = enable_rclpy
        self._graph: list[TopicGraphEntry] = []
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
        if self._enable_rclpy and self._thread is None:
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

    def is_up(self) -> bool:
        return self._up and self._dataflow_alive()

    def discover_topics(self) -> list[TopicGraphEntry]:
        with self._graph_lock:
            return list(self._graph)

    # -- dora_live wiring -----------------------------------------------------

    def set_dataflow_liveness(self, probe: Callable[[], bool]) -> None:
        self._dataflow_alive = probe

    def set_topic_types(self, topic_types: dict[str, str]) -> None:
        self._topic_types = dict(topic_types)

    def ingest_batch(self, rows: list[dict[str, Any]]) -> int:
        """Feed one pushed batch; returns the number of samples delivered.

        Row shape (metrics node contract): ``{"topic": str, "recv_t": float,
        "size": int, "stamp_s": float|None, "bridged": bool}``.
        """
        sink = self._sink
        if sink is None or self._paused:
            return 0
        delivered = 0
        for row in rows:
            topic = row["topic"]
            sink(
                Sample(
                    topic=topic,
                    type=self._topic_types.get(topic),
                    recv_t=float(row["recv_t"]),
                    size_bytes=int(row.get("size") or 0),
                    stamp_s=row.get("stamp_s"),
                )
            )
            delivered += 1
        return delivered

    # -- discovery poller ------------------------------------------------------

    def _graph_loop(self) -> None:
        try:
            import rclpy
            from rclpy.node import Node
        except Exception:  # pragma: no cover - exercised only without ROS
            logger.warning("rclpy unavailable; discovery disabled")
            return
        context = rclpy.Context()
        rclpy.init(context=context)
        node = Node(self._node_name, context=context)
        try:
            while not self._stop_evt.wait(DISCOVERY_PERIOD_S):
                entries: list[TopicGraphEntry] = []
                for name, types in node.get_topic_names_and_types():
                    entries.append(
                        TopicGraphEntry(
                            name=name,
                            type=types[0] if types else None,
                            publisher_count=node.count_publishers(name),
                            subscriber_count=node.count_subscribers(name),
                        )
                    )
                with self._graph_lock:
                    self._graph = entries
        finally:
            node.destroy_node()
            rclpy.shutdown(context=context)
