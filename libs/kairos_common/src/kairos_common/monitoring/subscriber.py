"""The ROS abstraction seam for topic_monitor.

The windowed-metric math (``metrics.py``) and the monitoring service
(``monitor.py``) depend only on this module, never on rclpy. A
:class:`TopicSubscriber` produces :class:`Sample` records — one per received
message — carrying just what lightweight, non-destructive monitoring needs:
arrival time, serialized size, topic name/type, and ``header.stamp`` *only when
it can be obtained safely*. Payloads are not decoded by default.

This Protocol is the seam between the metric math and ROS: the
real rclpy implementation lives in :mod:`topic_monitor.ros_subscriber` (imported
lazily, skipped when ROS is absent), while tests drive the metric math with a
:class:`FakeSubscriber` and synthetic samples — no live ROS graph required.
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol, runtime_checkable

from kairos_common.monitoring.models import QosInfo


@dataclass(frozen=True, slots=True)
class Sample:
    """One observation of a received message (no payload decode).

    Attributes:
        topic: Full topic name the message arrived on.
        type: ROS 2 message type (e.g. ``sensor_msgs/msg/Image``), if known.
        recv_t: Arrival time in monotonic seconds (``time.monotonic``).
        size_bytes: Serialized message size in bytes.
        stamp_s: ``header.stamp`` as POSIX seconds, or ``None`` when no usable
            stamp is safely available (no header, decode disabled, or zero
            stamp). Drives ``stamp_delay_ms``; never required for hz/bw/gap.
    """

    topic: str
    type: str | None
    recv_t: float
    size_bytes: int
    stamp_s: float | None = None


@dataclass
class PublisherInfo:
    """A publisher discovered on a topic, with its offered QoS (for auto-match)."""

    topic: str
    type: str | None
    qos: QosInfo


@dataclass
class TopicGraphEntry:
    """A topic seen on the ROS 2 graph (discovery for ``GET /topics``)."""

    name: str
    type: str | None = None
    publisher_count: int = 0
    subscriber_count: int = 0


@runtime_checkable
class TopicSubscriber(Protocol):
    """Source of :class:`Sample` records and ROS-graph discovery.

    Implementations push every received message to the callback registered via
    :meth:`set_sink`. ``start`` brings the subscriptions up; ``pause`` /
    ``resume`` stop / restart delivering samples without tearing the node down
    (so a recording can lighten the monitor's load). ``stop`` shuts it down.
    """

    def set_sink(self, sink: Callable[[Sample], None]) -> None:
        """Register the callback that receives every :class:`Sample`."""
        ...

    def set_lost_sink(self, sink: Callable[[str, int], None]) -> None:
        """Register the callback for DDS message_lost events ``(topic, delta)``."""
        ...

    def start(self) -> None:
        """Bring subscriptions up and begin delivering samples."""
        ...

    def pause(self) -> None:
        """Stop delivering samples (monitoring paused)."""
        ...

    def resume(self) -> None:
        """Resume delivering samples after a pause."""
        ...

    def stop(self) -> None:
        """Tear down subscriptions and release resources."""
        ...

    def is_up(self) -> bool:
        """Whether the underlying node/subscriptions are up (readiness)."""
        ...

    def discover_topics(self) -> list[TopicGraphEntry]:
        """Return the current ROS 2 graph topics (name/type/pub/sub counts)."""
        ...


class FakeSubscriber:
    """In-memory :class:`TopicSubscriber` for tests (no ROS).

    Tests call :meth:`feed` (or :meth:`emit`) to push synthetic samples through
    the same sink the real subscriber uses, exercising the full metric path via
    the FastAPI app without a live ROS graph.
    """

    def __init__(self, graph: list[TopicGraphEntry] | None = None) -> None:
        self._sink: Callable[[Sample], None] | None = None
        self._lost_sink: Callable[[str, int], None] | None = None
        self._up = False
        self._paused = False
        self._graph = list(graph or [])
        self._lock = threading.Lock()

    def set_sink(self, sink: Callable[[Sample], None]) -> None:
        self._sink = sink

    def set_lost_sink(self, sink: Callable[[str, int], None]) -> None:
        self._lost_sink = sink

    def emit_lost(self, topic: str, count_change: int) -> None:
        """Push a synthetic DDS message_lost event through the lost sink."""
        if self._lost_sink is not None:
            self._lost_sink(topic, count_change)

    def start(self) -> None:
        self._up = True
        self._paused = False

    def pause(self) -> None:
        self._paused = True

    def resume(self) -> None:
        self._paused = False

    def stop(self) -> None:
        self._up = False

    def is_up(self) -> bool:
        return self._up

    def discover_topics(self) -> list[TopicGraphEntry]:
        with self._lock:
            return list(self._graph)

    def set_graph(self, graph: list[TopicGraphEntry]) -> None:
        """Replace the discovery graph the fake reports."""
        with self._lock:
            self._graph = list(graph)

    def emit(self, sample: Sample) -> None:
        """Push one sample through the sink (no-op while paused)."""
        if self._sink is not None and not self._paused:
            self._sink(sample)

    def feed(
        self,
        topic: str,
        recv_t: float,
        size_bytes: int,
        type: str | None = None,
        stamp_s: float | None = None,
    ) -> None:
        """Convenience: build a :class:`Sample` and :meth:`emit` it."""
        self.emit(
            Sample(
                topic=topic,
                type=type,
                recv_t=recv_t,
                size_bytes=size_bytes,
                stamp_s=stamp_s,
            )
        )
