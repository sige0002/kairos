# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""SSE aggregation hub for ``GET /api/v1/events``.

Multiplexes the orchestrator's event sources into a single Server-Sent-Events
stream per ``api_orchestrator.md``:

- ``record_status`` — emitted by the run lifecycle on state changes
  (``{capture_id, run_id, state, message_count, bytes}``).
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
# Bridge connectivity: emitted on up/down transitions of the monitor SSE legs
# so the UI can show an honest "robot offline" instead of a green badge that
# only proves the LOCAL pipe to the orchestrator is open (the cross-host split
# runs the monitor on the robot — a powered-off robot must be visible).
EVENT_BRIDGE = "bridge"


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
        # Ids must stay monotonic ACROSS restarts, not just within one
        # process: a browser reconnects with the Last-Event-ID of a PREVIOUS
        # boot, and if this boot's counter can catch up to that number the
        # replay logic would hand it another process's events as a normal
        # tail instead of a resync. Seeding from wall-clock milliseconds
        # keeps the id an int (the wire contract) while putting every boot
        # far ahead of anything an earlier boot could have issued — the
        # counter advances one per event against a thousand ticks per
        # second, so it can never catch the next boot's seed.
        self._next_id = int(time.time() * 1000)
        self._subscribers: set[asyncio.Queue[Event]] = set()
        # Queues that overflowed and silently lost their oldest events; the
        # subscribe loop owes each of these a resync before its next event.
        self._gapped: set[asyncio.Queue[Event]] = set()
        self._lock = asyncio.Lock()
        self._tasks: list[asyncio.Task[None]] = []
        self._closing = False
        # Per-leg monitor SSE connectivity; the aggregate transitions publish
        # EVENT_BRIDGE. None = no attempt has resolved yet.
        self._legs_up: dict[str, bool] = {}
        self._monitor_up: bool | None = None

    @property
    def monitor_status(self) -> str | None:
        """Current monitor-bridge state: ``"up"`` / ``"down"`` / ``None``."""
        if self._monitor_up is None:
            return None
        return "up" if self._monitor_up else "down"

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
                if queue in self._gapped:
                    # This queue overflowed and events were dropped from it;
                    # the client's cache has an unannounced hole, which only a
                    # full refetch repairs (same contract as the ring cases).
                    self._gapped.discard(queue)
                    yield self._resync_event("subscriber overflow")
                yield event
        finally:
            async with self._lock:
                self._subscribers.discard(queue)
            self._gapped.discard(queue)

    # ---- internals --------------------------------------------------------

    def _replay_since(self, last_event_id: int | None) -> list[Event]:
        """Compute the replay list for a (re)connecting subscriber.

        Returns a ``resync`` sentinel event when the requested id names a
        position this hub cannot vouch for (the client must refetch);
        otherwise the buffered tail with a larger id (possibly empty).

        A client id is unvouchable three ways. Before 2026-08-12 only the
        first was handled, so a browser that survived an orchestrator RESTART
        got no resync and silently kept every stale cache — record status,
        captures, configs — until something else happened to make it refetch:

        - older than the ring's oldest entry (fell out of the buffer),
        - AHEAD of the highest id this process has ever issued (impossible
          within one process — the client cannot have seen ids we never
          sent; a restart marker, e.g. when the clock stepped backwards),
        - behind an EMPTY ring's issued count (events the client missed were
          evicted by age before it reconnected).

        Cross-boot ids from a normally-forward clock never collide with this
        boot's counter at all: the counter is seeded from wall-clock
        milliseconds (see ``__init__``), so a previous boot's id lands below
        this boot's oldest entry and takes the first branch. Without that
        seed, a busy new process whose counter overtook the old browser's id
        would answer it with ANOTHER PROCESS's events as a normal tail.

        The one vouchable empty-ring position — the client id EQUALS the
        highest issued id (fully caught up; the quiet tail just aged out) —
        replays nothing rather than forcing a refetch.
        """
        if last_event_id is None:
            return []
        issued = self._next_id - 1  # highest id this process has ever issued
        if last_event_id > issued:
            return [self._resync_event("last_event_id out of range")]
        if not self._ring:
            if last_event_id == issued:
                return []
            return [self._resync_event("last_event_id out of range")]
        oldest = self._ring[0].id
        if last_event_id < oldest - 1:
            return [self._resync_event("last_event_id out of range")]
        return [e for e in self._ring if e.id > last_event_id]

    def _resync_event(self, reason: str) -> Event:
        """A synthetic ``resync`` sentinel telling the client to refetch."""
        issued = self._next_id - 1
        return Event(
            id=issued if issued > 0 else 0,
            event="resync",
            data={"reason": reason},
            ts=time.monotonic(),
        )

    def _evict_expired(self) -> None:
        """Drop ring entries older than the max age (maxlen handles count)."""
        cutoff = time.monotonic() - RING_MAX_AGE_S
        while self._ring and self._ring[0].ts < cutoff:
            self._ring.popleft()

    def _offer(self, queue: asyncio.Queue[Event], event: Event) -> None:
        """Enqueue without blocking; a full queue drops its oldest event.

        The drop is not silent to the client: the queue is marked gapped, and
        the subscribe loop injects a ``resync`` before its next delivery.
        Without that, a slow subscriber lost low-frequency job/record/alert
        transitions with no id gap and no resync — its caches then held wrong
        terminal states with nothing left to correct them.
        """
        try:
            queue.put_nowait(event)
        except asyncio.QueueFull:
            self._gapped.add(queue)
            with contextlib.suppress(asyncio.QueueEmpty):
                queue.get_nowait()
            with contextlib.suppress(asyncio.QueueFull):
                queue.put_nowait(event)

    async def _bridge(self, path: str, event_type: str) -> None:
        """Subscribe to one monitor SSE leg and republish into the hub.

        Reconnects with backoff on any failure (the monitor may be down or
        restart). Cancelled on shutdown. Up/down transitions feed the
        aggregated EVENT_BRIDGE state; only the FIRST failure of an outage is
        a warning — with the robot powered off the retry loop otherwise spams
        the log every backoff interval, forever.
        """
        logged_down = False
        while not self._closing:
            try:
                async for _evt, data in self._monitor.stream_sse(path):
                    if not self._legs_up.get(path):
                        logged_down = False
                        await self._set_leg(path, up=True)
                    parsed = self._parse_json(data)
                    if parsed is not None:
                        await self.publish(event_type, parsed)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - keep the bridge alive.
                log = logger.debug if logged_down else logger.warning
                log(
                    "monitor SSE bridge error",
                    extra={"path": path, "error": str(exc)},
                )
                logged_down = True
            # Mark the leg down on failure OR on a first attempt that never
            # connected (robot off from startup must still publish "down").
            if self._legs_up.get(path, True):
                await self._set_leg(path, up=False)
            if self._closing:
                break
            await asyncio.sleep(RECONNECT_BACKOFF_S)

    async def _set_leg(self, path: str, *, up: bool) -> None:
        """Record one leg's state; publish EVENT_BRIDGE on aggregate change."""
        self._legs_up[path] = up
        aggregate = any(self._legs_up.values())
        if aggregate != self._monitor_up:
            self._monitor_up = aggregate
            await self.publish(EVENT_BRIDGE, {"monitor": "up" if aggregate else "down"})

    @staticmethod
    def _parse_json(data: str) -> dict[str, Any] | None:
        """Parse a monitor SSE ``data:`` payload into a dict, or ``None``."""
        try:
            obj = json.loads(data)
        except (ValueError, TypeError):
            return None
        return obj if isinstance(obj, dict) else {"data": obj}
