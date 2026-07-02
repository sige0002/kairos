"""SSE aggregation hub for ``GET /api/v1/events``.

Multiplexes the orchestrator's event sources into a single Server-Sent-Events
stream per ``api_orchestrator.md``:

- ``record_status`` — emitted by the run lifecycle on state changes
  (``{run_id, state, message_count, bytes}``).
- ``metrics`` — topic_monitor's periodic snapshot (proxied from its
  ``/metrics/stream``).
- ``alert`` — topic_monitor alerts (proxied from its ``/alerts/stream``).
- ``job`` — stage 3 pipeline job progress, emitted by the jobs router
  (``routers/jobs.py``) on create and on observed state/progress changes.

Wire format: ``id:`` (monotonic int) / ``event:`` (type) / ``data:`` (JSON).

Reconnect: clients send ``Last-Event-ID``; the hub keeps an in-memory ring
buffer (default 1000 events / 5 min) and replays un-sent events. If the
requested id is older than the buffer, it emits ``event: resync`` so the client
refetches current state, then resumes live.

The hub owns background tasks that subscribe to the monitor's SSE legs and
republish into the ring/fan-out, with reconnect-on-failure backoff. Those tasks
are started/stopped with the app lifespan.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from collections import deque
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

from api_orchestrator.monitor_client import MonitorClient

logger = logging.getLogger("kairos")

# Ring buffer bounds (api_orchestrator.md: default 1000 events / 5 minutes).
RING_MAX_EVENTS = 1000
RING_MAX_AGE_S = 300.0
# Per-subscriber queue bound; a client that can't keep up is disconnected
# rather than letting the hub buffer unbounded memory.
SUBSCRIBER_QUEUE_MAX = 1000
# Reconnect backoff for the upstream monitor SSE legs.
RECONNECT_BACKOFF_S = 2.0

# Event types the hub understands (config.md / api_orchestrator.md vocabulary).
EVENT_RECORD_STATUS = "record_status"
EVENT_METRICS = "metrics"
EVENT_ALERT = "alert"
EVENT_JOB = "job"


@dataclass(frozen=True)
class Event:
    """One aggregated SSE event with its monotonic id and wall-clock time."""

    id: int
    event: str
    data: dict[str, Any]
    ts: float

    def encode(self) -> str:
        """Render this event in the SSE wire format (id / event / data)."""
        payload = json.dumps(self.data, separators=(",", ":"))
        return f"id: {self.id}\nevent: {self.event}\ndata: {payload}\n\n"


def encode_comment(text: str) -> str:
    """Render an SSE comment line (used as a keep-alive heartbeat)."""
    return f": {text}\n\n"


class EventHub:
    """In-memory SSE fan-out with a replay ring buffer and monitor bridges."""

    def __init__(self, monitor: MonitorClient) -> None:
        self._monitor = monitor
        self._ring: deque[Event] = deque(maxlen=RING_MAX_EVENTS)
        self._next_id = 1
        self._subscribers: set[asyncio.Queue[Event]] = set()
        self._lock = asyncio.Lock()
        self._tasks: list[asyncio.Task[None]] = []
        self._closing = False

    # ---- lifecycle --------------------------------------------------------

    async def start(self) -> None:
        """Start the background monitor-SSE bridge tasks."""
        self._closing = False
        self._tasks = [
            asyncio.create_task(
                self._bridge("/metrics/stream", EVENT_METRICS), name="sse-metrics"
            ),
            asyncio.create_task(
                self._bridge("/alerts/stream", EVENT_ALERT), name="sse-alerts"
            ),
        ]

    async def stop(self) -> None:
        """Cancel background tasks and disconnect subscribers."""
        self._closing = True
        for task in self._tasks:
            task.cancel()
        for task in self._tasks:
            with contextlib.suppress(asyncio.CancelledError):
                await task
        self._tasks = []

    # ---- publish / subscribe ---------------------------------------------

    async def publish(self, event_type: str, data: dict[str, Any]) -> Event:
        """Append an event to the ring and fan it out to live subscribers."""
        async with self._lock:
            event = Event(
                id=self._next_id, event=event_type, data=data, ts=time.monotonic()
            )
            self._next_id += 1
            self._ring.append(event)
            self._evict_expired()
            subscribers = list(self._subscribers)
        for queue in subscribers:
            self._offer(queue, event)
        return event

    async def subscribe(self, last_event_id: int | None = None) -> AsyncIterator[Event]:
        """Yield events: replay (per ``Last-Event-ID``) then live.

        - ``last_event_id`` ``None`` (first connect): only live events follow.
        - in range: replay every buffered event with a larger id, then live.
        - out of range (older than the buffer's oldest): emit a synthetic
          ``resync`` event so the client refetches, then live.
        """
        queue: asyncio.Queue[Event] = asyncio.Queue(maxsize=SUBSCRIBER_QUEUE_MAX)
        async with self._lock:
            self._evict_expired()
            replay = self._replay_since(last_event_id)
            self._subscribers.add(queue)
        try:
            for event in replay:
                yield event
            while True:
                event = await queue.get()
                yield event
        finally:
            async with self._lock:
                self._subscribers.discard(queue)

    # ---- internals --------------------------------------------------------

    def _replay_since(self, last_event_id: int | None) -> list[Event]:
        """Compute the replay list for a (re)connecting subscriber.

        Returns a ``resync`` sentinel event when the requested id predates the
        buffer (the client must refetch); otherwise the buffered tail with a
        larger id (possibly empty).
        """
        if last_event_id is None:
            return []
        if not self._ring:
            return []
        oldest = self._ring[0].id
        if last_event_id < oldest - 1:
            # Requested position fell out of the ring -> tell the client to
            # resync (refetch current state), then resume live from here.
            return [
                Event(
                    id=self._next_id - 1 if self._next_id > 1 else 0,
                    event="resync",
                    data={"reason": "last_event_id out of range"},
                    ts=time.monotonic(),
                )
            ]
        return [e for e in self._ring if e.id > last_event_id]

    def _evict_expired(self) -> None:
        """Drop ring entries older than the max age (maxlen handles count)."""
        cutoff = time.monotonic() - RING_MAX_AGE_S
        while self._ring and self._ring[0].ts < cutoff:
            self._ring.popleft()

    @staticmethod
    def _offer(queue: asyncio.Queue[Event], event: Event) -> None:
        """Enqueue without blocking; drop the slowest event if a client lags."""
        try:
            queue.put_nowait(event)
        except asyncio.QueueFull:
            # Client is too slow: drop the oldest to make room (best-effort).
            with contextlib.suppress(asyncio.QueueEmpty):
                queue.get_nowait()
            with contextlib.suppress(asyncio.QueueFull):
                queue.put_nowait(event)

    async def _bridge(self, path: str, event_type: str) -> None:
        """Subscribe to one monitor SSE leg and republish into the hub.

        Reconnects with backoff on any failure (the monitor may be down or
        restart). Cancelled on shutdown.
        """
        while not self._closing:
            try:
                async for _evt, data in self._monitor.stream_sse(path):
                    parsed = self._parse_json(data)
                    if parsed is not None:
                        await self.publish(event_type, parsed)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - keep the bridge alive.
                logger.warning(
                    "monitor SSE bridge error",
                    extra={"path": path, "error": str(exc)},
                )
            if self._closing:
                break
            await asyncio.sleep(RECONNECT_BACKOFF_S)

    @staticmethod
    def _parse_json(data: str) -> dict[str, Any] | None:
        """Parse a monitor SSE ``data:`` payload into a dict, or ``None``."""
        try:
            obj = json.loads(data)
        except (ValueError, TypeError):
            return None
        return obj if isinstance(obj, dict) else {"data": obj}
