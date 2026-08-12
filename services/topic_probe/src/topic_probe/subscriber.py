# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""The ROS abstraction seam for topic_probe.

The probe service (:mod:`topic_probe.probe`) depends only on this Protocol,
never on rclpy. Unlike the monitor's seam, this one DECODES: it keeps the most
recently received, decoded message for each *subscribed* topic so the service
can introspect its fields and sample chosen fields' values.

**Multiple topics can be subscribed concurrently** (overlay across topics, e.g.
left arm / right arm). Subscriptions are **ref-counted**: each ``subscribe``
bumps a count and each ``unsubscribe`` drops it; the underlying ROS subscription
is created on the first reference and torn down when the last one is released.

The real rclpy implementation lives in :mod:`topic_probe.ros_subscriber`
(imported lazily, skipped when ROS is absent). Tests drive the service with a
:class:`FakeProbeSubscriber` fed plain Python / fake-decoded objects — no live
ROS graph required, and rclpy is never imported.
"""

from __future__ import annotations

import threading
from collections import Counter
from dataclasses import dataclass
from typing import Protocol, runtime_checkable


@dataclass(frozen=True, slots=True)
class TopicMeta:
    """A topic discovered on the ROS 2 graph (for ``GET /topics``)."""

    name: str
    type: str | None = None


@runtime_checkable
class ProbeSubscriber(Protocol):
    """Multi-topic decoding subscriber + ROS-graph discovery.

    ``subscribe`` / ``unsubscribe`` ref-count a decoding subscription per topic;
    ``latest`` returns the most recently decoded message object for a subscribed
    topic (or ``None`` before its first message / when not subscribed), which the
    service introspects and samples. ``start`` / ``stop`` manage the node.
    """

    def start(self) -> None:
        """Bring the node up (no subscriptions until ``subscribe``)."""
        ...

    def stop(self) -> None:
        """Tear down all subscriptions and the node, release resources."""
        ...

    def is_up(self) -> bool:
        """Whether the underlying node is up (readiness)."""
        ...

    def discover_topics(self) -> list[TopicMeta]:
        """Return the current ROS 2 graph topics (name + type)."""
        ...

    def subscribe(self, topic: str) -> None:
        """Add a (ref-counted) decoding subscription to *topic*."""
        ...

    def unsubscribe(self, topic: str) -> None:
        """Release one reference; tear down the subscription at zero."""
        ...

    def subscribed_topics(self) -> list[str]:
        """Topics with at least one active reference."""
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
        self._refs: Counter[str] = Counter()
        self._graph = list(graph or [])
        self._messages: dict[str, object] = {}
        self._lock = threading.Lock()

    def start(self) -> None:
        self._up = True

    def stop(self) -> None:
        self._up = False
        with self._lock:
            self._refs.clear()

    def is_up(self) -> bool:
        return self._up

    def discover_topics(self) -> list[TopicMeta]:
        with self._lock:
            return list(self._graph)

    def set_graph(self, graph: list[TopicMeta]) -> None:
        """Replace the discovery graph the fake reports."""
        with self._lock:
            self._graph = list(graph)

    def subscribe(self, topic: str) -> None:
        with self._lock:
            self._refs[topic] += 1

    def unsubscribe(self, topic: str) -> None:
        # Mirror the real subscriber: an unsubscribe for a topic with no live
        # reference (double unsubscribe / lost race) is a no-op, not a KeyError.
        with self._lock:
            count = self._refs.get(topic, 0)
            if count <= 0:
                return
            if count <= 1:
                del self._refs[topic]
            else:
                self._refs[topic] -= 1

    def subscribed_topics(self) -> list[str]:
        with self._lock:
            return list(self._refs)

    def latest(self, topic: str) -> object | None:
        # Mirror the real subscriber: only subscribed topics have a live message.
        with self._lock:
            if topic not in self._refs:
                return None
            return self._messages.get(topic)

    def set_message(self, topic: str, message: object) -> None:
        """Register the decoded message the fake returns for *topic*."""
        with self._lock:
            self._messages[topic] = message
