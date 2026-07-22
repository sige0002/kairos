"""The rclpy-backed :class:`~topic_monitor.subscriber.TopicSubscriber`.

This is the real ROS seam: an rclpy node that subscribes to the allowlist
topics with auto-matched QoS (``qos_match.py``) and emits one
:class:`~topic_monitor.subscriber.Sample` per received message — recording only
arrival time and serialized size, **never decoding the payload** (lightweight,
non-destructive monitoring, per the spec). The executor spins on a background
thread so it never blocks the asyncio web server.

rclpy and the rmw bindings are imported lazily inside :meth:`start`, so importing
this module (and the rest of topic_monitor) needs no ROS install — the FastAPI
app boots and the pure-logic units are tested without rclpy. The live subscribe
path is exercised in Docker (ROS image), not in the native unit tests.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from fnmatch import fnmatch
from typing import Any

from kairos_common import RecordingConfig

from topic_monitor.models import QosInfo
from topic_monitor.qos_match import resolve_subscription_qos
from topic_monitor.subscriber import Sample, TopicGraphEntry

logger = logging.getLogger("kairos.topic_monitor")

# How often the node re-scans the graph for newly-appeared allowlist topics.
_DISCOVERY_PERIOD_S = 2.0


class RosTopicSubscriber:
    """rclpy implementation of the :class:`TopicSubscriber` Protocol.

    Subscribes to every topic on the ``default_topics`` allowlist (concrete
    names and glob patterns), choosing a QoS compatible with each topic's
    publishers via :func:`resolve_subscription_qos`. Generic raw subscriptions
    deliver the serialized CDR buffer so we measure size without deserialising.
    """

    def __init__(
        self,
        allowlist: list[str],
        *,
        config: RecordingConfig | None = None,
        node_name: str = "topic_monitor",
    ) -> None:
        self._allowlist = list(allowlist)
        self._config = config
        self._node_name = node_name
        self._sink: Callable[[Sample], None] | None = None
        self._lost_sink: Callable[[str, int], None] | None = None
        self._lock = threading.Lock()
        self._paused = False
        self._up = False
        self._subscribed: dict[str, QosInfo] = {}
        self._node: Any = None
        self._executor: Any = None
        self._thread: threading.Thread | None = None
        self._discovery_timer: Any = None

    def set_sink(self, sink: Callable[[Sample], None]) -> None:
        self._sink = sink

    def set_lost_sink(self, sink: Callable[[str, int], None]) -> None:
        self._lost_sink = sink

    def start(self) -> None:
        with self._lock:
            if self._up:
                return
        # MON-H1: claim readiness (_up) only AFTER the node is actually spinning.
        # Setting it first made /readyz report 200 even when _spin_up() raised
        # (e.g. rclpy missing / init failure) — "ready but silent". On failure we
        # roll back any partially-built node and re-raise so the caller (the app
        # lifespan) can log it and readiness stays false.
        try:
            self._spin_up()
        except Exception:
            self._abandon_partial()
            raise
        with self._lock:
            self._up = True

    def _abandon_partial(self) -> None:
        """Tear down a partially-constructed node after a failed :meth:`start`."""
        with self._lock:
            node, executor = self._node, self._executor
            self._node = self._executor = self._thread = self._discovery_timer = None
        if executor is not None:
            try:
                executor.shutdown()
            except Exception:  # noqa: BLE001 - best-effort rollback
                logger.exception("error shutting down executor after failed start")
        if node is not None:
            try:
                node.destroy_node()
            except Exception:  # noqa: BLE001 - best-effort rollback
                logger.exception("error destroying node after failed start")

    def _spin_up(self) -> None:
        """Create the rclpy node and spin it on a background thread."""
        import rclpy
        from rclpy.executors import SingleThreadedExecutor
        from rclpy.node import Node

        if not rclpy.ok():
            rclpy.init()
        node = Node(self._node_name)
        self._node = node
        self._refresh_subscriptions()
        # Periodically pick up allowlist topics whose publishers appear later.
        self._discovery_timer = node.create_timer(
            _DISCOVERY_PERIOD_S, self._refresh_subscriptions
        )

        executor = SingleThreadedExecutor()
        executor.add_node(node)
        thread = threading.Thread(
            target=executor.spin, name="topic-monitor-spin", daemon=True
        )
        self._executor = executor
        self._thread = thread
        thread.start()
        logger.info(
            "topic_monitor subscriber started",
            extra={"component": "topic_monitor", "allowlist": self._allowlist},
        )

    def _matches_allowlist(self, topic: str) -> bool:
        return any(fnmatch(topic, pattern) for pattern in self._allowlist)

    def _refresh_subscriptions(self) -> None:
        """Subscribe to any not-yet-subscribed allowlist topic on the graph.

        Runs on the executor spin thread via the discovery timer. MON-H2: the
        graph queries (``get_topic_names_and_types`` / ``get_publishers_info_by_
        topic``) can raise an rmw error, and an unguarded raise here kills the
        spin thread silently — metrics then stop forever while ``/readyz`` keeps
        claiming ready. So the whole body is guarded: log and retry next tick.
        """
        node = self._node
        if node is None:
            return
        try:
            for name, types in node.get_topic_names_and_types():
                if name in self._subscribed or not self._matches_allowlist(name):
                    continue
                type_str = types[0] if types else None
                qos = self._resolve_qos(node, name)
                self._subscribe(node, name, type_str, qos)
        except Exception:  # noqa: BLE001 - must not kill the spin thread
            logger.exception("discovery refresh failed; will retry next tick")

    def _resolve_qos(self, node: Any, topic: str) -> QosInfo:
        """Auto-match a subscription QoS from the topic's publishers."""
        publishers = [
            QosInfo(
                reliability=_reliability_str(info.qos_profile.reliability),
                durability=_durability_str(info.qos_profile.durability),
                depth=getattr(info.qos_profile, "depth", 1) or 1,
            )
            for info in node.get_publishers_info_by_topic(topic)
        ]
        default_depth = (
            self._config.monitor.qos_depth if self._config is not None else 10
        )
        return resolve_subscription_qos(
            topic, publishers, self._config, default_depth=default_depth
        )

    def _subscribe(
        self, node: Any, topic: str, type_str: str | None, qos: QosInfo
    ) -> None:
        """Create a raw (no-decode) subscription for *topic* with *qos*."""
        profile = _to_qos_profile(qos)
        if type_str is None:
            return
        try:
            node.create_subscription(
                _message_class(type_str),
                topic,
                self._make_callback(topic, type_str),
                profile,
                raw=True,
                event_callbacks=self._event_callbacks(topic),
            )
        except Exception:  # noqa: BLE001 - one bad topic must not stop the rest
            logger.exception("failed to subscribe", extra={"topic": topic})
            return
        self._subscribed[topic] = qos
        logger.info("subscribed", extra={"component": "topic_monitor", "topic": topic})

    def _make_callback(self, topic: str, type_str: str) -> Callable[[Any], None]:
        def _on_message(raw: Any) -> None:
            # raw=True delivers the serialized CDR bytes: measure size, no decode.
            if self._sink is None or self._paused:
                return
            self._sink(
                Sample(
                    topic=topic,
                    type=type_str,
                    recv_t=time.monotonic(),
                    size_bytes=len(raw),
                )
            )

        return _on_message

    def _event_callbacks(self, topic: str) -> Any:
        """rmw QoS event callbacks for a subscription.

        ``message_lost`` is the middleware's own count of samples it dropped (a
        full queue, etc.) — the one honest "real loss" signal available without
        sequence numbers or payload decode. We forward each event's
        ``total_count_change`` to the lost sink. Built lazily so importing this
        module needs no rclpy.
        """
        from rclpy.event_handler import SubscriptionEventCallbacks

        def _on_lost(info: Any) -> None:
            sink = self._lost_sink
            if sink is None:
                return
            # QoSMessageLostInfo: total_count (cumulative) + total_count_change.
            delta = getattr(info, "total_count_change", 0)
            if delta:
                sink(topic, int(delta))

        return SubscriptionEventCallbacks(message_lost=_on_lost)

    def pause(self) -> None:
        with self._lock:
            self._paused = True

    def resume(self) -> None:
        with self._lock:
            self._paused = False

    def is_up(self) -> bool:
        with self._lock:
            return self._up

    def discover_topics(self) -> list[TopicGraphEntry]:
        node = self._node
        if node is None:
            return []
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
        return entries

    def stop(self) -> None:
        with self._lock:
            if not self._up:
                return
            self._up = False
            node, executor, thread = self._node, self._executor, self._thread
            self._node = self._executor = self._thread = None
        if executor is not None:
            try:
                executor.shutdown()
            except Exception:  # noqa: BLE001 - best-effort teardown
                logger.exception("error shutting down ros executor")
        if node is not None:
            try:
                node.destroy_node()
            except Exception:  # noqa: BLE001
                logger.exception("error destroying ros node")
        if thread is not None and thread.is_alive():
            thread.join(timeout=2.0)
        logger.info("topic_monitor subscriber stopped")


def _message_class(type_str: str) -> Any:
    """Resolve a ROS 2 message class from a ``pkg/msg/Type`` string."""
    from rosidl_runtime_py.utilities import get_message

    return get_message(type_str)


def _to_qos_profile(qos: QosInfo) -> Any:
    """Build an rclpy ``QoSProfile`` from a resolved :class:`QosInfo`."""
    from rclpy.qos import (
        DurabilityPolicy,
        HistoryPolicy,
        QoSProfile,
        ReliabilityPolicy,
    )

    reliability = (
        ReliabilityPolicy.BEST_EFFORT
        if qos.reliability == "best_effort"
        else ReliabilityPolicy.RELIABLE
    )
    durability = (
        DurabilityPolicy.TRANSIENT_LOCAL
        if qos.durability == "transient_local"
        else DurabilityPolicy.VOLATILE
    )
    return QoSProfile(
        reliability=reliability,
        durability=durability,
        history=HistoryPolicy.KEEP_LAST,
        depth=max(1, qos.depth),
    )


def _reliability_str(value: Any) -> str:
    """Normalise an rclpy reliability policy to our string vocabulary."""
    from rclpy.qos import ReliabilityPolicy

    return "best_effort" if value == ReliabilityPolicy.BEST_EFFORT else "reliable"


def _durability_str(value: Any) -> str:
    from rclpy.qos import DurabilityPolicy

    return (
        "transient_local" if value == DurabilityPolicy.TRANSIENT_LOCAL else "volatile"
    )
