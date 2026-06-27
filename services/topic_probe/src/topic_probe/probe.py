"""The topic_probe service logic (ROS-free, driven through the seam).

Wires a :class:`~topic_probe.subscriber.ProbeSubscriber` to the API: topic
discovery, per-topic numeric-field introspection, and field sampling. All blocking
work (the bounded wait for the first decoded message) is synchronous here; the
FastAPI layer runs it off the event loop via ``asyncio.to_thread``.

**Multiple topics can be subscribed concurrently** (overlay across topics). The
subscriber ref-counts subscriptions, so a transient introspection (:meth:`fields`)
and a long-lived stream can both hold the same topic without fighting. A stream
calls :meth:`subscribe` / :meth:`unsubscribe` around its lifetime and samples per
tick via :meth:`sample_many`.
"""

from __future__ import annotations

import logging
import time

from kairos_common import utc_now_iso8601

from topic_probe.field_introspect import extract_value, iter_numeric_fields
from topic_probe.models import (
    FieldsResponse,
    MultiSample,
    Sample,
    TopicInfo,
    TopicsResponse,
)
from topic_probe.subscriber import ProbeSubscriber

logger = logging.getLogger("kairos.topic_probe")

# How long /fields waits for the first decoded message on a freshly-subscribed
# topic before giving up (the topic must be actively publishing to introspect).
_FIELD_WAIT_S = 1.0
_FIELD_POLL_S = 0.02


class ProbeService:
    """Generic numeric-field live plotter over decoding subscriptions."""

    def __init__(self, subscriber: ProbeSubscriber) -> None:
        self._sub = subscriber

    def start(self) -> None:
        self._sub.start()

    def stop(self) -> None:
        self._sub.stop()

    def is_ready(self) -> bool:
        return self._sub.is_up()

    # ---- subscription lifetime (used by the /stream endpoint) -------------
    def subscribe(self, topic: str) -> None:
        self._sub.subscribe(topic)

    def unsubscribe(self, topic: str) -> None:
        self._sub.unsubscribe(topic)

    def subscribed_count(self) -> int:
        """Number of distinct topics currently subscribed (for the UI warning)."""
        return len(self._sub.subscribed_topics())

    def topics(self) -> TopicsResponse:
        """Discover the ROS 2 graph topics available to probe."""
        topics = [
            TopicInfo(name=meta.name, type=meta.type)
            for meta in self._sub.discover_topics()
        ]
        topics.sort(key=lambda t: t.name)
        return TopicsResponse(ts=utc_now_iso8601(), topics=topics)

    def _type_for(self, topic: str) -> str | None:
        for meta in self._sub.discover_topics():
            if meta.name == topic:
                return meta.type
        return None

    def fields(
        self,
        topic: str,
        *,
        wait_s: float = _FIELD_WAIT_S,
        poll_s: float = _FIELD_POLL_S,
    ) -> FieldsResponse:
        """List the topic's dotted numeric field paths (introspected live).

        Holds a transient (ref-counted) subscription to *topic*, waits up to
        *wait_s* for a decoded message, then walks its numeric leaves. The
        subscription is released afterwards (a concurrent stream keeps its own
        reference). Returns an empty list with a ``reason`` when no message
        arrives or the type has no numeric fields.
        """
        self._sub.subscribe(topic)
        try:
            msg = self._sub.latest(topic)
            deadline = time.monotonic() + max(0.0, wait_s)
            while msg is None and time.monotonic() < deadline:
                time.sleep(poll_s)
                msg = self._sub.latest(topic)
        finally:
            # Keep the subscription one tick so a stream that subscribes right
            # after introspection doesn't have to re-establish from scratch; the
            # stream's own subscribe() (if any) already bumped the ref-count.
            self._sub.unsubscribe(topic)

        ts = utc_now_iso8601()
        type_str = self._type_for(topic)
        if msg is None:
            return FieldsResponse(
                ts=ts,
                topic=topic,
                type=type_str,
                fields=[],
                reason="no message received (is the topic publishing?)",
            )
        paths = iter_numeric_fields(msg)
        return FieldsResponse(
            ts=ts,
            topic=topic,
            type=type_str,
            fields=paths,
            reason=None if paths else "no numeric fields in this message type",
        )

    def sample(self, topic: str, field: str) -> Sample:
        """Sample *field* off the most recent decoded message of *topic*.

        Non-blocking: returns ``value=None`` until a message has arrived (so the
        caller can emit keep-alive frames immediately). The caller is responsible
        for having subscribed the topic.
        """
        msg = self._sub.latest(topic)
        value = extract_value(msg, field) if msg is not None else None
        return Sample(topic=topic, field=field, t=time.time(), value=value)

    def sample_blocking(
        self,
        topic: str,
        field: str,
        *,
        wait_s: float = _FIELD_WAIT_S,
        poll_s: float = _FIELD_POLL_S,
    ) -> Sample:
        """One-shot ``/sample``: subscribe, wait for a message, sample, release."""
        self._sub.subscribe(topic)
        try:
            msg = self._sub.latest(topic)
            deadline = time.monotonic() + max(0.0, wait_s)
            while msg is None and time.monotonic() < deadline:
                time.sleep(poll_s)
                msg = self._sub.latest(topic)
            value = extract_value(msg, field) if msg is not None else None
            return Sample(topic=topic, field=field, t=time.time(), value=value)
        finally:
            self._sub.unsubscribe(topic)

    def sample_many(self, topic: str, fields: list[str]) -> MultiSample:
        """Sample several *fields* off one decoded message of *topic*.

        Reads the latest message once and extracts each field, so an overlay
        chart gets all of a topic's series in a single SSE frame. The caller is
        responsible for having subscribed the topic.
        """
        msg = self._sub.latest(topic)
        values: dict[str, float | None] = {
            field: (extract_value(msg, field) if msg is not None else None)
            for field in fields
        }
        return MultiSample(topic=topic, t=time.time(), values=values)
