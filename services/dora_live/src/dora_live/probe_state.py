"""ProbeHub: shared state between the probe HTTP app and the probe node.

The probe dataflow node polls ``active()`` (via ``GET /internal/probe/active``
each 500 ms tick) and pushes values back; SSE streams and one-shot samples
read the latest cache. Ref-counting mirrors topic_probe: a topic stays active
while at least one stream (or a pending one-shot) references it.
"""

from __future__ import annotations

import threading
import time
from collections import Counter
from typing import Any


class ProbeHub:
    """Thread-safe active-set + latest-value cache."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._refs: Counter[str] = Counter()
        self._fields: dict[str, set[str]] = {}
        self._introspect: set[str] = set()
        self._latest: dict[str, dict[str, Any]] = {}
        self._field_lists: dict[str, tuple[list[str], str | None]] = {}
        self._events: dict[str, threading.Event] = {}

    # -- HTTP app side ------------------------------------------------------

    def acquire(self, topic: str, fields: list[str]) -> None:
        with self._lock:
            self._refs[topic] += 1
            self._fields.setdefault(topic, set()).update(fields)

    def release(self, topic: str, fields: list[str]) -> None:
        with self._lock:
            self._refs[topic] -= 1
            if self._refs[topic] <= 0:
                del self._refs[topic]
                self._fields.pop(topic, None)
                self._latest.pop(topic, None)
            # Field sets shrink only when the topic fully releases; per-field
            # refcounts are not worth the bookkeeping at <=20 Hz.

    def request_introspect(self, topic: str) -> None:
        with self._lock:
            self._introspect.add(topic)
            self._field_lists.pop(topic, None)

    def latest(self, topic: str) -> dict[str, Any] | None:
        with self._lock:
            return self._latest.get(topic)

    def field_list(self, topic: str) -> tuple[list[str], str | None] | None:
        with self._lock:
            return self._field_lists.get(topic)

    def wait_for(self, topic: str, timeout: float) -> dict[str, Any] | None:
        """Block until a value for ``topic`` arrives (or timeout)."""
        with self._lock:
            if topic in self._latest:
                return self._latest[topic]
            evt = self._events.setdefault(topic, threading.Event())
            evt.clear()
        if not evt.wait(timeout):
            return None
        with self._lock:
            return self._latest.get(topic)

    # -- probe node side -------------------------------------------------------

    def active(self) -> dict[str, Any]:
        with self._lock:
            return {
                "topics": {
                    topic: sorted(self._fields.get(topic, set()))
                    for topic in self._refs
                },
                "introspect": sorted(self._introspect),
            }

    def push_values(
        self, topic: str, t: float, values: dict[str, float | None]
    ) -> None:
        with self._lock:
            self._latest[topic] = {"topic": topic, "t": t, "values": values}
            evt = self._events.get(topic)
        if evt is not None:
            evt.set()

    def push_fields(
        self, topic: str, fields: list[str], reason: str | None = None
    ) -> None:
        with self._lock:
            self._field_lists[topic] = (fields, reason)
            self._introspect.discard(topic)
            evt = self._events.get(topic)
        if evt is not None:
            evt.set()

    def wait_for_fields(
        self, topic: str, timeout: float
    ) -> tuple[list[str], str | None] | None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            got = self.field_list(topic)
            if got is not None:
                return got
            time.sleep(0.05)
        return None
