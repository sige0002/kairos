"""Latest-frame-wins frame buffer (the spec's "Frame Queue").

The streamer is a low-latency *preview* path: when frames arrive faster than a
client consumes them, the right behaviour is to **drop the old frame and keep
the newest** rather than queue and fall behind. This module is that policy,
isolated from ROS and aiortc so it can be unit-tested directly.

A :class:`LatestFrame` holds at most one frame. Producers (the ROS subscriber
callback, on its own thread) call :meth:`put`, which overwrites any frame not
yet taken — that overwrite *is* the frame drop. Consumers (one aiortc track per
client) call :meth:`get`, which blocks until a frame is available or the buffer
is closed.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass


@dataclass
class FrameStats:
    """Counters for a :class:`LatestFrame`, surfaced in ``/stream/status``.

    ``produced`` counts every frame handed to :meth:`LatestFrame.put`;
    ``dropped`` counts those overwritten before any consumer took them (the
    frame-drop the preview path accepts). ``delivered`` counts frames returned
    by :meth:`LatestFrame.get`.
    """

    produced: int = 0
    dropped: int = 0
    delivered: int = 0


class LatestFrame[T]:
    """A single-slot buffer that always holds the most recent frame.

    Thread-safe: producers and consumers run on different threads (the rclpy
    executor vs. the asyncio media tracks). The slot holds at most one frame;
    :meth:`put` overwrites an un-taken frame (dropping it), so a slow consumer
    never builds a backlog and always sees the freshest frame.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._available = threading.Condition(self._lock)
        self._frame: T | None = None
        self._has_frame = False
        self._closed = False
        self._stats = FrameStats()

    def put(self, frame: T) -> None:
        """Store *frame*, dropping any previous un-taken frame.

        No-op once :meth:`close` has been called, so a late producer callback
        after teardown cannot resurrect the buffer.
        """
        with self._available:
            if self._closed:
                return
            if self._has_frame:
                # An un-taken frame is still in the slot: overwriting it is the
                # frame drop the preview path accepts (latest-frame-wins).
                self._stats.dropped += 1
            self._frame = frame
            self._has_frame = True
            self._stats.produced += 1
            self._available.notify()

    def get(self, timeout: float | None = None) -> T | None:
        """Return and clear the current frame, blocking until one arrives.

        Blocks up to *timeout* seconds (``None`` = forever) for a frame. Returns
        the frame and empties the slot, or ``None`` if the buffer was closed or
        the wait timed out without a frame.
        """
        with self._available:
            if not self._has_frame and not self._closed:
                self._available.wait(timeout)
            if self._closed or not self._has_frame:
                return None
            frame = self._frame
            self._frame = None
            self._has_frame = False
            self._stats.delivered += 1
            return frame

    def latest_nowait(self) -> T | None:
        """Return the current frame without blocking or clearing it.

        Used by consumers that poll (e.g. a media track timing its own pacing);
        returns ``None`` if no frame is currently buffered.
        """
        with self._lock:
            return self._frame if self._has_frame else None

    def close(self) -> None:
        """Close the buffer: wake all waiters and reject further frames.

        After this, :meth:`get` returns ``None`` and :meth:`put` is a no-op, so
        consumers unblock and tear down cleanly on stream stop.
        """
        with self._available:
            self._closed = True
            self._frame = None
            self._has_frame = False
            self._available.notify_all()

    @property
    def closed(self) -> bool:
        with self._lock:
            return self._closed

    def stats(self) -> FrameStats:
        """Snapshot of the produced/dropped/delivered counters."""
        with self._lock:
            return FrameStats(
                produced=self._stats.produced,
                dropped=self._stats.dropped,
                delivered=self._stats.delivered,
            )
