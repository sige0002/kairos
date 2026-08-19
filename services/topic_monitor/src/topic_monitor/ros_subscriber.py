# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""The rclpy-backed :class:`~kairos_common.monitoring.subscriber.TopicSubscriber`.

This is the real ROS seam: an rclpy node that subscribes to the allowlist
topics with auto-matched QoS (``qos_match.py``) and emits one
:class:`~kairos_common.monitoring.subscriber.Sample` per received message
— recording only
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
from dataclasses import dataclass
from fnmatch import fnmatch
from typing import Any

from kairos_common import RecordingConfig
from kairos_common.monitoring.models import QosInfo
from kairos_common.monitoring.qos_match import (
    durability_str,
    publisher_qos_infos,
    reliability_str,
    resolve_subscription_qos,
)
from kairos_common.monitoring.subscriber import Sample, TopicGraphEntry

logger = logging.getLogger("kairos.topic_monitor")

# How often the node re-scans the graph for newly-appeared allowlist topics.
_DISCOVERY_PERIOD_S = 2.0

PublisherFingerprint = tuple[tuple[str, str, str, str, int], ...]


@dataclass
class _SubscriptionState:
    """The graph assumptions and runtime evidence for one subscription."""

    handle: Any
    type_name: str
    qos: QosInfo
    publisher_fingerprint: PublisherFingerprint
    subscribed_at: float
    last_sample_at: float | None = None


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
        self._lifecycle_lock = threading.RLock()
        self._lock = threading.Lock()
        self._paused = False
        self._up = False
        self._subscribed: dict[str, _SubscriptionState] = {}
        self._node: Any = None
        self._executor: Any = None
        self._thread: threading.Thread | None = None
        self._discovery_timer: Any = None

    def set_sink(self, sink: Callable[[Sample], None]) -> None:
        self._sink = sink

    def set_lost_sink(self, sink: Callable[[str, int], None]) -> None:
        self._lost_sink = sink

    def start(self) -> None:
        with self._lifecycle_lock:
            with self._lock:
                if self._up and self._thread is not None and self._thread.is_alive():
                    return
                stale = self._up or any(
                    value is not None
                    for value in (self._node, self._executor, self._thread)
                )
            if stale:
                self.stop()
            # MON-H1: claim readiness (_up) only AFTER the node is spinning.
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
            node, executor, thread = self._node, self._executor, self._thread
            self._node = self._executor = self._thread = self._discovery_timer = None
            self._subscribed.clear()
        self._teardown(node, executor, thread)

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
        self._executor = executor
        executor.add_node(node)
        thread = threading.Thread(
            target=executor.spin, name="topic-monitor-spin", daemon=True
        )
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
            seen: set[str] = set()
            for name, types in node.get_topic_names_and_types():
                if not self._matches_allowlist(name):
                    continue
                seen.add(name)
                type_str = types[0] if types else None
                publishers, fingerprint = _publisher_snapshot(node, name)
                qos = self._resolve_qos(node, name, publishers=publishers)
                with self._lock:
                    current = self._subscribed.get(name)
                if (
                    current is not None
                    and current.type_name == type_str
                    and current.qos == qos
                    and current.publisher_fingerprint == fingerprint
                ):
                    continue
                if current is not None:
                    self._teardown_subscription(node, name)
                    logger.info(
                        "recreating subscription after publisher/QoS change",
                        extra={"component": "topic_monitor", "topic": name},
                    )
                self._subscribe(node, name, type_str, qos, fingerprint)

            with self._lock:
                stale = set(self._subscribed) - seen
            for topic in stale:
                self._teardown_subscription(node, topic)
        except Exception:  # noqa: BLE001 - must not kill the spin thread
            logger.exception("discovery refresh failed; will retry next tick")

    def _resolve_qos(
        self,
        node: Any,
        topic: str,
        *,
        publishers: list[QosInfo] | None = None,
    ) -> QosInfo:
        """Auto-match a subscription QoS from the topic's publishers.

        ``monitor.qos_depth`` is the configured depth FLOOR (team finding:
        without it the floor fell back to the function default of 10, while
        the (now-retired) dora_live lane already floored at the configured
        30 — the monitor would
        still undercount faster bursts than the ~50 Hz case that exposed it).
        """
        default_depth = (
            self._config.monitor.qos_depth if self._config is not None else 10
        )
        return resolve_subscription_qos(
            topic,
            publisher_qos_infos(node, topic) if publishers is None else publishers,
            self._config,
            default_depth=default_depth,
        )

    def _subscribe(
        self,
        node: Any,
        topic: str,
        type_str: str | None,
        qos: QosInfo,
        fingerprint: PublisherFingerprint,
    ) -> None:
        """Create a raw (no-decode) subscription for *topic* with *qos*."""
        profile = _to_qos_profile(qos)
        if type_str is None:
            return
        try:
            handle = node.create_subscription(
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
        with self._lock:
            self._subscribed[topic] = _SubscriptionState(
                handle=handle,
                type_name=type_str,
                qos=qos,
                publisher_fingerprint=fingerprint,
                subscribed_at=time.monotonic(),
            )
        logger.info("subscribed", extra={"component": "topic_monitor", "topic": topic})

    def _teardown_subscription(self, node: Any, topic: str) -> None:
        """Destroy and forget one subscription on the executor thread."""
        with self._lock:
            state = self._subscribed.pop(topic, None)
        if state is None:
            return
        try:
            node.destroy_subscription(state.handle)
        except Exception:  # noqa: BLE001 - retrying must not kill discovery
            logger.exception(
                "failed to destroy stale subscription", extra={"topic": topic}
            )

    def _make_callback(self, topic: str, type_str: str) -> Callable[[Any], None]:
        def _on_message(raw: Any) -> None:
            # raw=True delivers the serialized CDR bytes: measure size, no decode.
            now = time.monotonic()
            with self._lock:
                state = self._subscribed.get(topic)
                if state is not None:
                    state.last_sample_at = now
                sink = self._sink
                paused = self._paused
            if sink is None or paused:
                return
            sink(
                Sample(
                    topic=topic,
                    type=type_str,
                    recv_t=now,
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
            return bool(
                self._up and self._thread is not None and self._thread.is_alive()
            )

    def diagnostics(self) -> dict[str, Any]:
        """Return subscription state and freshness for operator diagnosis."""
        now = time.monotonic()
        with self._lock:
            thread_alive = bool(self._thread and self._thread.is_alive())
            subscriptions = [
                {
                    "topic": topic,
                    "type": state.type_name,
                    "qos": state.qos.model_dump(),
                    "publisher_count": len(state.publisher_fingerprint),
                    "subscription_age_s": max(0.0, now - state.subscribed_at),
                    "last_sample_age_s": (
                        None
                        if state.last_sample_at is None
                        else max(0.0, now - state.last_sample_at)
                    ),
                }
                for topic, state in sorted(self._subscribed.items())
            ]
            up = self._up
        return {
            "state": "ready" if up and thread_alive else "not_ready",
            "executor_thread_alive": thread_alive,
            "subscription_count": len(subscriptions),
            "subscriptions": subscriptions,
        }

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
        with self._lifecycle_lock:
            with self._lock:
                if not self._up and all(
                    value is None
                    for value in (self._node, self._executor, self._thread)
                ):
                    return
                self._up = False
                node, executor, thread = self._node, self._executor, self._thread
                self._node = self._executor = self._thread = self._discovery_timer = (
                    None
                )
                self._subscribed.clear()
            self._teardown(node, executor, thread)
        logger.info("topic_monitor subscriber stopped")

    @staticmethod
    def _teardown(node: Any, executor: Any, thread: threading.Thread | None) -> None:
        """Release detached ROS resources, attempting every cleanup step."""
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


def _publisher_snapshot(
    node: Any, topic: str
) -> tuple[list[QosInfo], PublisherFingerprint]:
    """Read publisher QoS and a stable endpoint fingerprint in one graph query."""
    publishers: list[QosInfo] = []
    fingerprint: list[tuple[str, str, str, str, int]] = []
    for info in node.get_publishers_info_by_topic(topic):
        profile = info.qos_profile
        reliability = reliability_str(profile.reliability)
        durability = durability_str(profile.durability)
        depth = getattr(profile, "depth", 1) or 1
        publishers.append(
            QosInfo(
                reliability=reliability,
                durability=durability,
                depth=depth,
            )
        )
        gid = getattr(info, "endpoint_gid", None)
        try:
            endpoint = bytes(gid).hex() if gid is not None else ""
        except (TypeError, ValueError):
            endpoint = str(gid)
        if not endpoint:
            endpoint = (
                f"{getattr(info, 'node_namespace', '')}/"
                f"{getattr(info, 'node_name', '')}"
            )
        fingerprint.append(
            (
                endpoint,
                str(getattr(info, "topic_type", "")),
                reliability,
                durability,
                int(depth),
            )
        )
    return publishers, tuple(sorted(fingerprint))


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
