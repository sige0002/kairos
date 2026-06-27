"""The rclpy-backed :class:`~topic_probe.subscriber.ProbeSubscriber`.

The real ROS seam: an rclpy node that subscribes to **multiple selected topics
concurrently** and DECODES each message (topic_probe is isolated from the
monitor/recorder precisely so decoding here cannot affect them). The most recent
decoded message is held per topic for the service to introspect / sample.

Thread-safety: ``subscribe`` / ``unsubscribe`` are called from web threads but
only record the *desired* (ref-counted) topic set; a node timer running ON the
executor thread reconciles the actual subscriptions (rclpy node mutation is not
safe off the spin thread). This mirrors topic_monitor's discovery-timer approach.

rclpy is imported lazily inside :meth:`start`, so importing this module needs no
ROS install — the live decode path is exercised only in Docker (ROS image).
"""

from __future__ import annotations

import logging
import threading
from collections import Counter
from typing import Any

from topic_probe.subscriber import TopicMeta

logger = logging.getLogger("kairos.topic_probe")

# How often the node reconciles live subscriptions with the desired topic set.
_RECONCILE_PERIOD_S = 0.05


class RosProbeSubscriber:
    """rclpy implementation of the :class:`ProbeSubscriber` Protocol.

    Subscribes to each desired topic with a permissive best-effort QoS (depth 1)
    so it attaches to almost any publisher without back-pressure, decodes each
    message, and keeps the latest per topic for sampling.
    """

    def __init__(self, *, node_name: str = "topic_probe") -> None:
        self._node_name = node_name
        self._lock = threading.Lock()
        self._up = False
        # Desired (ref-counted) topics — mutated by web threads.
        self._desired: Counter[str] = Counter()
        # Actually-subscribed topics + latest decoded — mutated on the spin thread.
        self._subs: dict[str, Any] = {}
        self._latest: dict[str, object] = {}
        self._node: Any = None
        self._executor: Any = None
        self._thread: threading.Thread | None = None
        self._reconcile_timer: Any = None

    # ---- lifecycle ---------------------------------------------------------
    def start(self) -> None:
        with self._lock:
            if self._up:
                return
            self._up = True
        self._spin_up()

    def _spin_up(self) -> None:
        import rclpy
        from rclpy.executors import SingleThreadedExecutor
        from rclpy.node import Node

        if not rclpy.ok():
            rclpy.init()
        node = Node(self._node_name)
        self._node = node
        self._reconcile_timer = node.create_timer(_RECONCILE_PERIOD_S, self._reconcile)

        executor = SingleThreadedExecutor()
        executor.add_node(node)
        thread = threading.Thread(
            target=executor.spin, name="topic-probe-spin", daemon=True
        )
        self._executor = executor
        self._thread = thread
        thread.start()
        logger.info("topic_probe subscriber started")

    def stop(self) -> None:
        with self._lock:
            if not self._up:
                return
            self._up = False
            node, executor, thread = self._node, self._executor, self._thread
            self._node = self._executor = self._thread = None
            self._desired.clear()
            self._subs.clear()
            self._latest.clear()
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
        logger.info("topic_probe subscriber stopped")

    def is_up(self) -> bool:
        with self._lock:
            return self._up

    # ---- discovery / selection --------------------------------------------
    def discover_topics(self) -> list[TopicMeta]:
        node = self._node
        if node is None:
            return []
        return [
            TopicMeta(name=name, type=types[0] if types else None)
            for name, types in node.get_topic_names_and_types()
        ]

    def subscribe(self, topic: str) -> None:
        # Only record intent; the reconcile timer (spin thread) does the work.
        with self._lock:
            self._desired[topic] += 1

    def unsubscribe(self, topic: str) -> None:
        with self._lock:
            if self._desired[topic] <= 1:
                del self._desired[topic]
            else:
                self._desired[topic] -= 1

    def subscribed_topics(self) -> list[str]:
        with self._lock:
            return list(self._desired)

    def latest(self, topic: str) -> object | None:
        with self._lock:
            return self._latest.get(topic)

    # ---- spin-thread reconciliation ---------------------------------------
    def _reconcile(self) -> None:
        """Make live subscriptions match the desired topic set.

        Runs on the executor thread (timer callback), so all node mutation is
        single-threaded. Adds subscriptions for newly-desired topics and tears
        down ones no longer referenced.
        """
        with self._lock:
            desired = set(self._desired)
        current = set(self._subs)
        for topic in current - desired:
            self._teardown_one(topic)
        for topic in desired - current:
            self._create_subscription(topic)

    def _teardown_one(self, topic: str) -> None:
        node = self._node
        sub = self._subs.pop(topic, None)
        if node is not None and sub is not None:
            try:
                node.destroy_subscription(sub)
            except Exception:  # noqa: BLE001
                logger.exception("error destroying probe subscription")
        with self._lock:
            self._latest.pop(topic, None)

    def _create_subscription(self, topic: str) -> None:
        node = self._node
        if node is None:
            return
        type_str = self._resolve_type(node, topic)
        if type_str is None:
            # Type not on the graph yet; the next reconcile retries.
            logger.warning("probe: no type for topic %s yet", topic)
            return
        try:
            msg_class = _message_class(type_str)
            subscription = node.create_subscription(
                msg_class, topic, self._make_callback(topic), _probe_qos()
            )
        except Exception:  # noqa: BLE001 - bad type / unknown msg: stay alive
            logger.exception("probe: failed to subscribe to %s", topic)
            return
        self._subs[topic] = subscription
        logger.info("probe subscribed (decoding) to %s [%s]", topic, type_str)

    def _resolve_type(self, node: Any, topic: str) -> str | None:
        for name, types in node.get_topic_names_and_types():
            if name == topic and types:
                return types[0]
        return None

    def _make_callback(self, topic: str):
        def _on_message(msg: Any) -> None:
            with self._lock:
                self._latest[topic] = msg

        return _on_message


def _message_class(type_str: str) -> Any:
    """Resolve a ROS 2 message class from a ``pkg/msg/Type`` string."""
    from rosidl_runtime_py.utilities import get_message

    return get_message(type_str)


def _probe_qos() -> Any:
    """Permissive QoS: best-effort, keep-last depth 1 (freshest sample, no block).

    best-effort attaches to both best-effort and reliable publishers, and depth 1
    means we always hold the newest message — exactly what a live plot wants.
    """
    from rclpy.qos import HistoryPolicy, QoSProfile, ReliabilityPolicy

    return QoSProfile(
        reliability=ReliabilityPolicy.BEST_EFFORT,
        history=HistoryPolicy.KEEP_LAST,
        depth=1,
    )
