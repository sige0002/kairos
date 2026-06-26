"""The ROS abstraction seam for topic_probe.

The probe service (:mod:`topic_probe.probe`) depends only on this Protocol,
never on rclpy. Unlike the monitor's seam, this one DECODES: it keeps the most
recently received, decoded message for the single *active* topic so the service
can introspect its fields and sample a chosen field's value. Only ONE topic is
subscribed at a time (the UI plots one field of one topic); switching topics
tears the old subscription down.

The real rclpy implementation lives in :mod:`topic_probe.ros_subscriber`
(imported lazily, skipped when ROS is absent). Tests drive the service with a
:class:`FakeProbeSubscriber` fed plain Python / fake-decoded objects — no live
ROS graph required, and rclpy is never imported.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Protocol, runtime_checkable


@dataclass(frozen=True, slots=True)
class TopicMeta:
    """A topic discovered on the ROS 2 graph (for ``GET /topics``)."""

    name: str
    type: str | None = None


@runtime_checkable
class ProbeSubscriber(Protocol):
    """Single-topic decoding subscriber + ROS-graph discovery.

    ``set_active`` selects the one topic currently subscribed (``None`` = none);
    ``latest`` returns the most recently decoded message object for that topic
    (or ``None`` before the first message arrives), which the service introspects
    and samples. ``start`` / ``stop`` manage the underlying node.
    """

    def start(self) -> None:
        """Bring the node up (no subscription until ``set_active``)."""
        ...

    def stop(self) -> None:
        """Tear down the subscription and node, release resources."""
        ...

    def is_up(self) -> bool:
        """Whether the underlying node is up (readiness)."""
        ...

    def discover_topics(self) -> list[TopicMeta]:
        """Return the current ROS 2 graph topics (name + type)."""
        ...

    def set_active(self, topic: str | None) -> None:
        """Subscribe to *topic* (decoding); ``None`` clears the subscription."""
        ...

    def active_topic(self) -> str | None:
        """The currently-subscribed topic, or ``None``."""
        ...

    def latest(self, topic: str) -> object | None:
        """Most recent decoded message for *topic*, or ``None`` if unavailable."""
        ...


class FakeProbeSubscriber:
    """In-memory :class:`ProbeSubscriber` for tests (no ROS).

    Tests register decoded objects with :meth:`set_message` and a discovery
    graph with :meth:`set_graph`, then drive the full service path (fields /
    sample / stream) without rclpy.
    """

    def __init__(self, graph: list[TopicMeta] | None = None) -> None:
        self._up = False
        self._active: str | None = None
        self._graph = list(graph or [])
        self._messages: dict[str, object] = {}
        self._lock = threading.Lock()

    def start(self) -> None:
        self._up = True

    def stop(self) -> None:
        self._up = False
        self._active = None

    def is_up(self) -> bool:
        return self._up

    def discover_topics(self) -> list[TopicMeta]:
        with self._lock:
            return list(self._graph)

    def set_graph(self, graph: list[TopicMeta]) -> None:
        """Replace the discovery graph the fake reports."""
        with self._lock:
            self._graph = list(graph)

    def set_active(self, topic: str | None) -> None:
        self._active = topic

    def active_topic(self) -> str | None:
        return self._active

    def latest(self, topic: str) -> object | None:
        # Mirror the real subscriber: only the active topic has a live message.
        if topic != self._active:
            return None
        with self._lock:
            return self._messages.get(topic)

    def set_message(self, topic: str, message: object) -> None:
        """Register the decoded message the fake returns for *topic*."""
        with self._lock:
            self._messages[topic] = message
