"""Latest-frame buffer + per-topic frame router for the in-node WebRTC lane.

The WebRTC dora node receives every bridged ``CompressedImage`` topic on one
bus (fan-in) and serves signaling from a thread in the SAME process. This module
is the thread-safe seam between the two:

- :class:`LatestFrame` — a single-slot, latest-frame-wins buffer (a slow client
  never builds a backlog; the overwrite *is* the frame drop the preview accepts).
- :class:`FrameRouter` — the node thread decodes a frame once and calls
  :meth:`FrameRouter.feed`; each active stream owns a :class:`LatestFrame` sink
  the router fans the (per-stream downscaled) frame into, and measures the real
  per-topic supply rate so ``/stream/status`` reports an honest ``fps``.
- :class:`RouterFrameSource` — the registry's ``FrameSource`` seam over one
  topic's router buffer.

No aiortc / OpenCV imports here (downscale is delegated and lazy), so the router
and its rate accounting are unit-testable directly.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Protocol, runtime_checkable

from dora_live.webrtc_convert import downscale_bgr

if TYPE_CHECKING:  # pragma: no cover - typing only
    import numpy as np

    Frame = np.ndarray[Any, Any]
else:  # numpy may be absent in the minimal unit-test env; frames are opaque there.
    Frame = Any


class LatestFrame[T]:
    """A single-slot buffer that always holds the most recent frame.

    Thread-safe: the producer (the dora node thread) and consumers (the asyncio
    media tracks) run on different threads. :meth:`put` overwrites an un-taken
    frame (dropping it), so a slow consumer never builds a backlog and always
    sees the freshest frame.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._frame: T | None = None
        self._has_frame = False
        self._closed = False

    def put(self, frame: T) -> None:
        """Store *frame*, dropping any previous un-taken frame.

        No-op once :meth:`close` has been called, so a late producer callback
        after teardown cannot resurrect the buffer.
        """
        with self._lock:
            if self._closed:
                return
            self._frame = frame
            self._has_frame = True

    def latest_nowait(self) -> T | None:
        """Return the current frame without blocking or clearing it.

        Consumers poll this (a media track timing its own pacing); returns
        ``None`` if no frame is currently buffered or the buffer is closed.
        """
        with self._lock:
            return self._frame if self._has_frame else None

    def close(self) -> None:
        """Close the buffer: reject further frames and clear the slot."""
        with self._lock:
            self._closed = True
            self._frame = None
            self._has_frame = False

    @property
    def closed(self) -> bool:
        with self._lock:
            return self._closed


class _RateMeter:
    """Sliding measure of recent input frame rate over a short window."""

    def __init__(self, window_s: float = 2.0) -> None:
        self._window_s = window_s
        self._times: list[float] = []
        self._lock = threading.Lock()
        self._clock = time.monotonic

    def tick(self) -> None:
        now = self._clock()
        with self._lock:
            self._times.append(now)
            cutoff = now - self._window_s
            while self._times and self._times[0] < cutoff:
                self._times.pop(0)

    def rate(self) -> float:
        now = self._clock()
        with self._lock:
            cutoff = now - self._window_s
            recent = [t for t in self._times if t >= cutoff]
        if len(recent) < 2:
            return 0.0
        span = recent[-1] - recent[0]
        return (len(recent) - 1) / span if span > 0 else 0.0


@dataclass
class _Sink:
    """One stream's buffer plus its per-stream downscale caps and pace."""

    buffer: LatestFrame[Frame]
    max_width: int | None
    max_height: int | None
    max_fps: int


class FrameRouter:
    """Routes decoded frames from the node thread to active stream buffers.

    Every ``CompressedImage`` topic fans into the node, but a frame is only
    decoded and fed when at least one stream is attached to that topic
    (:meth:`wants` gates the decode — no client watching a camera means no JPEG
    decode). A topic may carry more than one stream (e.g. vp8 + h264); the frame
    is decoded once and fanned out, downscaled per-sink. The per-topic rate meter
    ticks on every fed frame so :meth:`rate` is the real supplied fps.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._sinks: dict[str, list[_Sink]] = {}
        self._meters: dict[str, _RateMeter] = {}

    def attach(
        self,
        topic: str,
        buffer: LatestFrame[Frame],
        max_width: int | None = None,
        max_height: int | None = None,
        max_fps: int = 15,
    ) -> None:
        """Register a stream's buffer to receive *topic*'s frames."""
        with self._lock:
            self._sinks.setdefault(topic, []).append(
                _Sink(buffer, max_width, max_height, max_fps)
            )
            self._meters.setdefault(topic, _RateMeter())

    def detach(self, topic: str, buffer: LatestFrame[Frame]) -> None:
        """Unregister a stream's buffer; drop the topic when its last one goes."""
        with self._lock:
            sinks = self._sinks.get(topic)
            if not sinks:
                return
            remaining = [s for s in sinks if s.buffer is not buffer]
            if remaining:
                self._sinks[topic] = remaining
            else:
                del self._sinks[topic]
                self._meters.pop(topic, None)

    def wants(self, topic: str) -> bool:
        """Whether any stream is currently attached to *topic* (gates decode)."""
        with self._lock:
            return bool(self._sinks.get(topic))

    def decode_fps(self, topic: str) -> float:
        """Highest fps any attached stream consumes *topic* at (0 = none).

        The tracks pace their OUTPUT to ``max_fps``, so decoding faster than
        the fastest consumer only produces frames that are overwritten unseen
        — the node gates its decode rate on this (stateless codecs only; an
        inter-frame codec must decode every frame to stay coherent).
        """
        with self._lock:
            sinks = self._sinks.get(topic)
            return float(max(s.max_fps for s in sinks)) if sinks else 0.0

    def feed(self, topic: str, frame: Frame) -> None:
        """Fan one decoded BGR frame out to *topic*'s sinks (latest-frame-wins).

        *frame* is decoded once by the caller; each sink gets its own downscale.
        The cv2 work happens outside the lock so a resize never blocks attach /
        detach / wants.
        """
        with self._lock:
            sinks = list(self._sinks.get(topic, ()))
            meter = self._meters.get(topic)
        if not sinks:
            return
        if meter is not None:
            meter.tick()
        for sink in sinks:
            sink.buffer.put(downscale_bgr(frame, sink.max_width, sink.max_height))

    def rate(self, topic: str) -> float:
        """Recent measured supply rate for *topic* (frames/s), 0 if unknown."""
        with self._lock:
            meter = self._meters.get(topic)
        return meter.rate() if meter is not None else 0.0


@runtime_checkable
class FrameSource(Protocol):
    """A source of BGR preview frames for one stream (registry seam)."""

    @property
    def frames(self) -> LatestFrame[Frame]:
        """The latest-frame-wins buffer this source feeds."""
        ...

    def start(self) -> None:
        """Begin producing frames (idempotent)."""
        ...

    def stop(self) -> None:
        """Stop producing frames and release resources (idempotent)."""
        ...

    @property
    def fps(self) -> float:
        """Recent measured input frame rate (frames/s), 0 if unknown."""
        ...


class RouterFrameSource:
    """:class:`FrameSource` backed by a :class:`FrameRouter` for one topic.

    Unlike the standalone streamer's rclpy source, this never touches DDS: the
    frames already flow into the node over the dora bus. :meth:`start` attaches
    this stream's buffer to the router (so the node begins fanning *topic*'s
    frames into it) and :meth:`stop` detaches it. ``fps`` reports the router's
    real per-topic supply rate.
    """

    def __init__(
        self,
        router: FrameRouter,
        topic: str,
        *,
        max_width: int | None = None,
        max_height: int | None = None,
        max_fps: int = 15,
    ) -> None:
        self._router = router
        self._topic = topic
        self._max_width = max_width
        self._max_height = max_height
        self._max_fps = max_fps
        self._frames: LatestFrame[Frame] = LatestFrame()
        self._started = False

    @property
    def frames(self) -> LatestFrame[Frame]:
        return self._frames

    @property
    def fps(self) -> float:
        return self._router.rate(self._topic)

    def start(self) -> None:
        if self._started:
            return
        self._started = True
        self._router.attach(
            self._topic,
            self._frames,
            self._max_width,
            self._max_height,
            self._max_fps,
        )

    def stop(self) -> None:
        if not self._started:
            return
        self._started = False
        self._router.detach(self._topic, self._frames)
        self._frames.close()
