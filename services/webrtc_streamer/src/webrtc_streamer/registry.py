# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""The stream registry: one source + peer manager per previewed topic.

:class:`StreamRegistry` is the streamer's coordinator. It owns the live streams
(at most one per topic), each pairing a :class:`~webrtc_streamer.source.FrameSource`
(the ROS image -> latest-frame buffer) with a
:class:`~webrtc_streamer.peer.PeerManager` (per-client PeerConnections sharing
that buffer). It enforces the spec's behaviour: deterministic ``stream_id`` per
topic (a duplicate start returns the existing stream), and idle auto-stop of an
unreferenced stream after ``idle_timeout_s``.

It depends only on the :class:`FrameSource` / :class:`PeerManager` Protocols via
injected factories, so its start/stop/idle/status logic is unit-testable with
fakes — no rclpy, codec, or ICE. ``main.py`` injects the real rclpy/aiortc
factories. SDP offer/answer is delegated to the stream's peer manager.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field

from webrtc_streamer.models import (
    Capabilities,
    Encoding,
    StreamInfo,
    StreamStartRequest,
    StreamState,
    StreamStatusResponse,
)
from webrtc_streamer.peer import PeerManager
from webrtc_streamer.source import FrameSource

logger = logging.getLogger("kairos.webrtc_streamer")

# Default seconds a stream with no connected clients lives before auto-stopping.
DEFAULT_IDLE_TIMEOUT_S = 60.0

# Factory signatures injected by main.py (real) or tests (fakes).
SourceFactory = Callable[[StreamStartRequest], FrameSource]
PeerFactory = Callable[[StreamStartRequest, FrameSource], PeerManager]


def stream_id_for(topic: str, encoding: Encoding) -> str:
    """Derive a deterministic ``stream_id`` from *topic* (+ *encoding*).

    Deterministic so a duplicate start for the same topic/encoding maps to the
    same stream (and is deduplicated). A short hash keeps it URL-safe and avoids
    leaking the raw topic path into the id.
    """
    digest = hashlib.sha1(f"{topic}|{encoding.value}".encode()).hexdigest()
    return f"s_{digest[:12]}"


@dataclass
class _Stream:
    """One live preview stream: its source, peers, and metadata."""

    stream_id: str
    topic: str
    encoding: Encoding
    source: FrameSource
    peers: PeerManager
    state: StreamState = StreamState.starting
    # Monotonic time the stream last had zero clients (drives idle auto-stop).
    idle_since: float | None = field(default=None)
    start_done: threading.Event = field(default_factory=threading.Event)
    stop_done: threading.Event = field(default_factory=threading.Event)
    stop_requested: bool = False
    start_error: BaseException | None = None


class StreamRegistry:
    """Owns the live preview streams and their lifecycle.

    A single instance is shared by the FastAPI routes. All public methods are
    guarded by a lock so concurrent start/stop/status/offer requests see a
    consistent view.
    """

    def __init__(
        self,
        source_factory: SourceFactory,
        peer_factory: PeerFactory,
        *,
        idle_timeout_s: float = DEFAULT_IDLE_TIMEOUT_S,
        h264_supported: bool = False,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._source_factory = source_factory
        self._peer_factory = peer_factory
        self._idle_timeout_s = idle_timeout_s
        self._h264_supported = h264_supported
        self._clock = clock
        self._lock = threading.Lock()
        self._streams: dict[str, _Stream] = {}

    # -- start / stop -------------------------------------------------------

    async def start(self, request: StreamStartRequest) -> str:
        """Start a stream for ``request.topic`` (or return the existing one).

        Idempotent per topic/encoding: a duplicate start returns the existing
        ``stream_id`` without creating a second source or peer manager.
        """
        sid = stream_id_for(request.topic, request.encoding)
        owner = False
        waiting_for_start = False
        with self._lock:
            existing = self._streams.get(sid)
            if existing is not None:
                if existing.state is StreamState.live:
                    return sid
                stream = existing
                waiting_for_start = existing.state is StreamState.starting
                lifecycle_done = (
                    existing.start_done if waiting_for_start else existing.stop_done
                )
            else:
                source: FrameSource | None = None
                try:
                    source = self._source_factory(request)
                    peers = self._peer_factory(request, source)
                except BaseException:
                    if source is not None:
                        source.stop()
                    raise
                stream = _Stream(
                    stream_id=sid,
                    topic=request.topic,
                    encoding=request.encoding,
                    source=source,
                    peers=peers,
                    idle_since=self._clock(),
                )
                self._streams[sid] = stream
                owner = True

        if not owner:
            # A duplicate request observes the same transaction. It must not
            # report success while the first request is still starting, nor
            # resurrect a stream whose concurrent stop/failure rolled it back.
            await asyncio.to_thread(lifecycle_done.wait)
            with self._lock:
                if (
                    waiting_for_start
                    and self._streams.get(sid) is stream
                    and stream.state is StreamState.live
                ):
                    return sid
                error = stream.start_error
            if error is not None:
                raise RuntimeError("stream start failed") from error
            if waiting_for_start:
                raise RuntimeError("stream stopped while starting")
            raise RuntimeError("stream is stopping; retry after stop completes")

        # Bring the source up outside the lock (its rclpy spin-up may block),
        # then atomically publish it as live. Cancellation waits for the worker
        # thread before rollback so start() and stop() never run concurrently on
        # the same source.
        source_task = asyncio.create_task(asyncio.to_thread(stream.source.start))
        try:
            try:
                await asyncio.shield(source_task)
            except asyncio.CancelledError:
                try:
                    await source_task
                except Exception:  # preserve the caller's cancellation
                    logger.exception("source start also failed during cancellation")
                raise
        except BaseException as exc:
            with self._lock:
                stream.state = StreamState.stopping
                stream.start_error = exc
            try:
                await self._cleanup(stream, suppress=True)
            finally:
                with self._lock:
                    if self._streams.get(sid) is stream:
                        self._streams.pop(sid)
                stream.start_done.set()
                stream.stop_done.set()
            raise

        with self._lock:
            stopped = stream.stop_requested or self._streams.get(sid) is not stream
            if stopped:
                stream.state = StreamState.stopping
            else:
                stream.state = StreamState.live

        if stopped:
            try:
                await self._cleanup(stream)
            finally:
                with self._lock:
                    if self._streams.get(sid) is stream:
                        self._streams.pop(sid)
                stream.start_done.set()
                stream.stop_done.set()
            raise RuntimeError("stream stopped while starting")

        stream.start_done.set()
        logger.info(
            "stream started",
            extra={"component": "webrtc_streamer", "topic": request.topic},
        )
        return sid

    async def stop(self, stream_id: str) -> bool:
        """Stop and remove a stream (idempotent). Returns whether it existed."""
        with self._lock:
            stream = self._streams.get(stream_id)
            if stream is None:
                return False
            if stream.state is StreamState.starting:
                stream.stop_requested = True
                owns_cleanup = False
            elif stream.state is StreamState.stopping:
                owns_cleanup = False
            else:
                stream.state = StreamState.stopping
                owns_cleanup = True
        if not owns_cleanup:
            await asyncio.to_thread(stream.stop_done.wait)
            return True

        try:
            await self._cleanup(stream)
        finally:
            with self._lock:
                if self._streams.get(stream_id) is stream:
                    self._streams.pop(stream_id)
            stream.stop_done.set()
        logger.info(
            "stream stopped",
            extra={"component": "webrtc_streamer", "topic": stream.topic},
        )
        return True

    @staticmethod
    async def _cleanup(stream: _Stream, *, suppress: bool = False) -> None:
        """Release peers and source, attempting both even when either fails."""
        first_error: BaseException | None = None
        try:
            await stream.peers.close()
        except BaseException as exc:
            first_error = exc
            logger.exception("error closing stream peers")
        try:
            await asyncio.to_thread(stream.source.stop)
        except BaseException as exc:
            if first_error is None:
                first_error = exc
            logger.exception("error stopping stream source")
        if first_error is not None and not suppress:
            raise first_error

    async def stop_all(self) -> None:
        """Stop every stream (shutdown)."""
        for sid in self.stream_ids():
            await self.stop(sid)

    def stream_ids(self) -> list[str]:
        with self._lock:
            return list(self._streams)

    # -- signaling ----------------------------------------------------------

    async def handle_offer(
        self, stream_id: str, sdp: str, sdp_type: str
    ) -> tuple[str, str]:
        """Answer a client SDP offer on *stream_id*; raise KeyError if unknown."""
        with self._lock:
            stream = self._streams.get(stream_id)
            if stream is None or stream.state is not StreamState.live:
                raise KeyError(stream_id)
            stream.idle_since = None  # a client is connecting
            peers = stream.peers
        return await peers.handle_offer(sdp, sdp_type)

    # -- status / idle ------------------------------------------------------

    def status(self) -> StreamStatusResponse:
        """Build the ``GET /stream/status`` body (capabilities + per-stream)."""
        with self._lock:
            streams = [self._info(s) for s in self._streams.values()]
        return StreamStatusResponse(
            capabilities=Capabilities(h264=self._h264_supported),
            streams=streams,
        )

    def _info(self, stream: _Stream) -> StreamInfo:
        return StreamInfo(
            stream_id=stream.stream_id,
            topic=stream.topic,
            state=stream.state,
            clients=stream.peers.client_count(),
            fps=stream.source.fps,
            encoding=stream.encoding,
        )

    def reap_idle(self) -> list[str]:
        """Return the ids of streams idle past ``idle_timeout_s``.

        A stream is idle while it has zero connected clients; once it has been
        idle continuously for ``idle_timeout_s`` it is eligible for auto-stop.
        Updates each stream's ``idle_since`` and returns the now-expired ids
        (the caller stops them — done outside the lock as stop is async).
        """
        now = self._clock()
        expired: list[str] = []
        with self._lock:
            for stream in self._streams.values():
                if stream.state is not StreamState.live:
                    continue
                if stream.peers.client_count() > 0:
                    stream.idle_since = None
                    continue
                if stream.idle_since is None:
                    stream.idle_since = now
                elif now - stream.idle_since >= self._idle_timeout_s:
                    expired.append(stream.stream_id)
        return expired
