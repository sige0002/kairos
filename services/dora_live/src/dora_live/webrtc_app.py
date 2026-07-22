"""FastAPI signaling app for the in-node WebRTC lane.

Builds the ``webrtc_streamer``-compatible signaling surface
(``/stream/start|stop|status|offer`` + ``/healthz``) over a
:class:`~dora_live.webrtc_registry.StreamRegistry`. Unlike the standalone
streamer, the frame source is not an rclpy subscription but a
:class:`~dora_live.webrtc_frame.RouterFrameSource` bound to the node's
:class:`~dora_live.webrtc_frame.FrameRouter` — the frames already flow into the
node over the dora bus. The aiortc peer factory is imported lazily (inside the
default factory) so this app imports and serves ``/healthz`` without aiortc;
tests inject fakes for the full request path.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from kairos_common import ApiError, create_app, get_settings

from dora_live.webrtc_frame import FrameRouter, FrameSource, RouterFrameSource
from dora_live.webrtc_models import (
    AnswerResponse,
    Encoding,
    OfferRequest,
    StreamStartRequest,
    StreamStartResponse,
    StreamStatusResponse,
    StreamStopRequest,
)
from dora_live.webrtc_peer import PeerManager, apply_rtp_packet_max, h264_available
from dora_live.webrtc_registry import (
    DEFAULT_IDLE_TIMEOUT_S,
    PeerFactory,
    SourceFactory,
    StreamRegistry,
)

logger = logging.getLogger("kairos.dora_live.webrtc")

SERVICE_NAME = "dora_live_webrtc"

# How often the background task reaps streams that have been idle too long.
_IDLE_REAP_PERIOD_S = 5.0


def _router_source_factory(router: FrameRouter) -> SourceFactory:
    """Build the default source factory: a router buffer per topic."""

    def factory(request: StreamStartRequest) -> RouterFrameSource:
        return RouterFrameSource(
            router,
            request.topic,
            max_width=request.max_width,
            max_height=request.max_height,
            max_fps=request.max_fps,
        )

    return factory


def _real_peer_factory(request: StreamStartRequest, source: FrameSource) -> PeerManager:
    """Build the aiortc-backed peer manager (imports aiortc inside its methods)."""
    from dora_live.webrtc_peer import AiortcPeerManager

    settings = get_settings()
    return AiortcPeerManager(
        source.frames,
        encoding=request.encoding,
        max_fps=request.max_fps,
        ice_servers=settings.webrtc_ice_servers,
    )


def create_webrtc_app(
    router: FrameRouter,
    *,
    source_factory: SourceFactory | None = None,
    peer_factory: PeerFactory | None = None,
    h264_supported: bool | None = None,
    idle_timeout_s: float = DEFAULT_IDLE_TIMEOUT_S,
    bus_topics: set[str] | None = None,
) -> FastAPI:
    """Build the WebRTC signaling FastAPI app with the registry and routes wired.

    Args:
        router: the node's frame router; the default source factory attaches a
            per-topic buffer to it on stream start.
        source_factory: builds a :class:`FrameSource` per start (defaults to the
            router-backed factory; tests may inject a fake).
        peer_factory: builds a :class:`PeerManager` per start (defaults to the
            aiortc-backed factory; tests inject a fake that needs no aiortc).
        h264_supported: capability override; defaults to probing the runtime.
        idle_timeout_s: seconds a client-less stream lives before auto-stop.
    """
    apply_rtp_packet_max()  # before any PeerConnection packetizes media
    settings = get_settings()
    h264 = h264_available() if h264_supported is None else h264_supported
    registry = StreamRegistry(
        source_factory or _router_source_factory(router),
        peer_factory or _real_peer_factory,
        idle_timeout_s=idle_timeout_s,
        h264_supported=h264,
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        reaper = asyncio.create_task(_reap_idle_loop(registry))
        try:
            yield
        finally:
            reaper.cancel()
            try:
                await reaper
            except asyncio.CancelledError:
                pass
            await registry.stop_all()

    app = create_app(SERVICE_NAME, settings=settings)
    app.router.lifespan_context = lifespan
    app.state.registry = registry

    @app.get("/")
    async def root() -> dict[str, str]:
        """Root identifying the service and stage."""
        return {"service": SERVICE_NAME, "stage": "live"}

    @app.post("/stream/start", status_code=201, response_model=StreamStartResponse)
    async def stream_start(request: StreamStartRequest) -> StreamStartResponse:
        # Honesty guard: a topic that is not wired onto the bus would stream
        # the black fallback forever (the legacy streamer subscribed to any
        # topic directly, so this is a real contract difference — fail loudly).
        if bus_topics is not None and request.topic not in bus_topics:
            raise ApiError(
                status_code=409,
                code="topic_not_on_live_bus",
                message=(
                    "Topic is not bridged onto the live bus (compressed camera "
                    "topics come from the recording config's default_topics)."
                ),
                details={"topic": request.topic, "bus_topics": sorted(bus_topics)},
            )
        if request.encoding is Encoding.h264 and not h264:
            raise ApiError(
                status_code=409,
                code="encoding_unavailable",
                message="H.264 encoding is not available in this build.",
                details={"encoding": request.encoding.value},
            )
        # Source start may touch shared router state; keep the event loop free.
        sid = await asyncio.to_thread(registry.start, request)
        return StreamStartResponse(stream_id=sid)

    @app.post("/stream/stop")
    async def stream_stop(request: StreamStopRequest) -> dict[str, bool]:
        stopped = await registry.stop(request.stream_id)
        if not stopped:
            raise ApiError(
                status_code=404,
                code="stream_not_found",
                message="No such stream.",
                details={"stream_id": request.stream_id},
            )
        return {"stopped": True}

    @app.get("/stream/status", response_model=StreamStatusResponse)
    async def stream_status() -> StreamStatusResponse:
        return registry.status()

    @app.post("/stream/offer", response_model=AnswerResponse)
    async def stream_offer(request: OfferRequest) -> AnswerResponse:
        try:
            answer_sdp, answer_type = await registry.handle_offer(
                request.stream_id, request.sdp.sdp, request.sdp.type
            )
        except KeyError as exc:
            raise ApiError(
                status_code=404,
                code="stream_not_found",
                message="No such stream.",
                details={"stream_id": request.stream_id},
            ) from exc
        return AnswerResponse(type=answer_type, sdp=answer_sdp)

    return app


async def _reap_idle_loop(registry: StreamRegistry) -> None:
    """Periodically auto-stop streams with no clients past ``idle_timeout_s``."""
    while True:
        await asyncio.sleep(_IDLE_REAP_PERIOD_S)
        for sid in registry.reap_idle():
            await registry.stop(sid)
            logger.info(
                "stream auto-stopped (idle)",
                extra={"component": "dora_live.webrtc", "stream_id": sid},
            )
