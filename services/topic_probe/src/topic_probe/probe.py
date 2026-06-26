"""The topic_probe service logic (ROS-free, driven through the seam).

Wires a :class:`~topic_probe.subscriber.ProbeSubscriber` to the API: topic
discovery, per-topic numeric-field introspection, and field sampling. All blocking
work (the bounded wait for the first decoded message) is synchronous here; the
FastAPI layer runs it off the event loop via ``asyncio.to_thread``.

Only ONE topic is active at a time (the UI plots one field of one topic). Calls
that need a live message (:meth:`fields`, :meth:`sample`) select the topic first;
the streaming loop re-asserts its topic each tick so the active plot "wins".
"""

from __future__ import annotations

import logging
import time

from kairos_common import utc_now_iso8601

from topic_probe.field_introspect import extract_value, iter_numeric_fields
from topic_probe.models import FieldsResponse, Sample, TopicInfo, TopicsResponse
from topic_probe.subscriber import ProbeSubscriber

logger = logging.getLogger("kairos.topic_probe")

# How long /fields waits for the first decoded message on a freshly-selected
# topic before giving up (the topic must be actively publishing to introspect).
_FIELD_WAIT_S = 1.0
_FIELD_POLL_S = 0.02


class ProbeService:
    """Generic numeric-field live plotter over a single decoding subscription."""

    def __init__(self, subscriber: ProbeSubscriber) -> None:
        self._sub = subscriber

    def start(self) -> None:
        self._sub.start()

    def stop(self) -> None:
        self._sub.stop()

    def is_ready(self) -> bool:
        return self._sub.is_up()

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

        Selects *topic* as the active subscription and waits up to *wait_s* for a
        decoded message, then walks its numeric leaves. Returns an empty list
        with a ``reason`` when no message arrives or the type has no numeric
        fields.
        """
        self._sub.set_active(topic)
        msg = self._sub.latest(topic)
        deadline = time.monotonic() + max(0.0, wait_s)
        while msg is None and time.monotonic() < deadline:
            time.sleep(poll_s)
            msg = self._sub.latest(topic)

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

        Non-blocking: returns ``value=None`` until a message has arrived on the
        active topic (so the SSE stream emits keep-alive frames immediately).
        """
        self._sub.set_active(topic)
        msg = self._sub.latest(topic)
        value = extract_value(msg, field) if msg is not None else None
        return Sample(topic=topic, field=field, t=time.time(), value=value)
