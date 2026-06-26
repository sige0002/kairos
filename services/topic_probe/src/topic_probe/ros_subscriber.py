"""The rclpy-backed :class:`~topic_probe.subscriber.ProbeSubscriber`.

The real ROS seam: an rclpy node that subscribes to a SINGLE selected topic at a
time and DECODES each message (topic_probe is isolated from the monitor/recorder
precisely so decoding here cannot affect them). The most recent decoded message
is held for the service to introspect / sample.

Thread-safety: ``set_active`` is called from web threads, but rclpy node mutation
(create/destroy subscription) is not safe to do while the executor spins on
another thread. So ``set_active`` only records the *desired* topic; a node timer
running ON the executor thread reconciles the actual subscription. This mirrors
topic_monitor's discovery-timer approach.

rclpy is imported lazily inside :meth:`start`, so importing this module needs no
ROS install — the live decode path is exercised only in Docker (ROS image).
"""

from __future__ import annotations

import logging
import threading
from typing import Any

from topic_probe.subscriber import TopicMeta

logger = logging.getLogger("kairos.topic_probe")

# How often the node reconciles the active subscription with the desired topic.
_RECONCILE_PERIOD_S = 0.05


class RosProbeSubscriber:
    """rclpy implementation of the :class:`ProbeSubscriber` Protocol.

    Subscribes to one topic at a time with a permissive best-effort QoS (depth 1)
    so it attaches to almost any publisher without back-pressure, decodes each
    message, and keeps the latest for sampling.
    """

    def __init__(self, *, node_name: str = "topic_probe") -> None:
        self._node_name = node_name
        self._lock = threading.Lock()
        self._up = False
        # Desired vs actually-subscribed topic (reconciled on the spin thread).
        self._desired: str | None = None
        self._sub_topic: str | None = None
        self._latest_msg: object | None = None
        self._node: Any = None
        self._subscription: Any = None
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
            self._subscription = None
            self._sub_topic = None
            self._latest_msg = None
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

    def set_active(self, topic: str | None) -> None:
        # Only record intent; the reconcile timer (spin thread) does the work.
        with self._lock:
            self._desired = topic

    def active_topic(self) -> str | None:
        with self._lock:
            return self._desired

    def latest(self, topic: str) -> object | None:
        with self._lock:
            if topic != self._sub_topic:
                return None
            return self._latest_msg

    # ---- spin-thread reconciliation ---------------------------------------
    def _reconcile(self) -> None:
        """Switch the live subscription to match the desired topic.

        Runs on the executor thread (timer callback), so all node mutation is
        single-threaded. No-op when already on the desired topic.
        """
        with self._lock:
            desired = self._desired
            current = self._sub_topic
        if desired == current:
            return
        self._teardown_subscription()
        if desired is None:
            return
        self._create_subscription(desired)

    def _teardown_subscription(self) -> None:
        node, sub = self._node, self._subscription
        if node is not None and sub is not None:
            try:
                node.destroy_subscription(sub)
            except Exception:  # noqa: BLE001
                logger.exception("error destroying probe subscription")
        with self._lock:
            self._subscription = None
            self._sub_topic = None
            self._latest_msg = None

    def _create_subscription(self, topic: str) -> None:
        node = self._node
        if node is None:
            return
        type_str = self._resolve_type(node, topic)
        if type_str is None:
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
        with self._lock:
            self._subscription = subscription
            self._sub_topic = topic
            self._latest_msg = None
        logger.info("probe subscribed (decoding) to %s [%s]", topic, type_str)

    def _resolve_type(self, node: Any, topic: str) -> str | None:
        for name, types in node.get_topic_names_and_types():
            if name == topic and types:
                return types[0]
        return None

    def _make_callback(self, topic: str):
        def _on_message(msg: Any) -> None:
            with self._lock:
                # Drop late deliveries from a torn-down subscription.
                if self._sub_topic == topic:
                    self._latest_msg = msg

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
