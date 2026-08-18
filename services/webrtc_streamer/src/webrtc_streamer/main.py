# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""webrtc_streamer service entry point (Stage 2).

ROS 2 image topics -> browser, low-latency WebRTC preview (not the canonical
recording). This module wires the stream registry
(:mod:`webrtc_streamer.registry`) — which pairs a ROS image source with per-client
PeerConnections per previewed topic — to the WHEP-style signaling API
(``/stream/start|stop|status|offer``). Cross-cutting plumbing (health, error
shape, CORS, logging) comes from ``kairos_common.create_app``; CORS matters here
because the frontend offers SDP directly (``WEBRTC_PUBLIC_URL``).
See ``docs/specs/ja/webrtc_streamer.md``.

The ROS source and aiortc peer manager are constructed lazily per stream via
injected factories that import rclpy / aiortc only when a stream starts, so this
app imports and serves ``/healthz`` without ROS installed. The live media path
is verified in Docker.
"""

from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from kairos_common import ApiError, create_app, get_settings

from webrtc_streamer.models import (
    AnswerResponse,
    Encoding,
    OfferRequest,
    StreamStartRequest,
    StreamStartResponse,
    StreamStatusResponse,
    StreamStopRequest,
)
from webrtc_streamer.peer import PeerManager, h264_available
from webrtc_streamer.registry import (
    PeerFactory,
    SourceFactory,
    StreamRegistry,
)
from webrtc_streamer.source import FrameSource

logger = logging.getLogger("kairos.webrtc_streamer")

SERVICE_NAME = "webrtc_streamer"

# How often the background task reaps streams that have been idle too long.
_IDLE_REAP_PERIOD_S = 5.0

# aiortc hardcodes the RTP payload cap at 1300 B, yielding ~1350 B (IPv4) /
# ~1370 B (IPv6) datagrams. Over a reduced-MTU tunnel (Tailscale/WireGuard =
# 1280) every max-size media packet then fragments, and fragmented IPv6
# datagrams are black-holed by WireGuard — so a preview crossing Tailscale goes
# black whenever ICE nominates the v6 pair. Capping the payload so the whole
# datagram fits 1280 (1150 + RTP/SRTP/UDP/IPv6 headers = ~1220 < 1280) removes
# all fragmentation. WEBRTC_PACKET_MAX lets a same-LAN (MTU 1500) deployment
# restore 1300 if it prefers the ~12% lower header overhead.
_DEFAULT_PACKET_MAX = 1150


def _apply_rtp_packet_max() -> None:
    """Cap aiortc's RTP payload size to fit a reduced-MTU (e.g. Tailscale) path."""
    raw = os.getenv("WEBRTC_PACKET_MAX", str(_DEFAULT_PACKET_MAX))
    try:
        packet_max = int(raw)
    except ValueError:
        logger.warning(
            "invalid WEBRTC_PACKET_MAX %r; using %d", raw, _DEFAULT_PACKET_MAX
        )
        packet_max = _DEFAULT_PACKET_MAX
    patched: list[str] = []
    for mod_name in ("vpx", "h264"):
        try:
            mod = __import__(f"aiortc.codecs.{mod_name}", fromlist=["PACKET_MAX"])
        except Exception:  # noqa: BLE001 - aiortc absent (pure-logic unit-test host)
            continue
        if hasattr(mod, "PACKET_MAX"):
            mod.PACKET_MAX = packet_max
            patched.append(mod_name)
    if patched:
        logger.info(
            "capped RTP PACKET_MAX to %d for %s (fits reduced-MTU tunnels)",
            packet_max,
            ", ".join(patched),
        )


def _real_source_factory(request: StreamStartRequest) -> FrameSource:
    """Build the rclpy-backed image source (imports rclpy inside ``start``)."""
    from webrtc_streamer.source import RosImageSource

    return RosImageSource(
        request.topic,
        max_width=request.max_width,
        max_height=request.max_height,
    )


def _real_peer_factory(request: StreamStartRequest, source: FrameSource) -> PeerManager:
    """Build the aiortc-backed peer manager (imports aiortc inside its methods)."""
    from webrtc_streamer.peer import AiortcPeerManager

    settings = get_settings()
    return AiortcPeerManager(
        source.frames,
        encoding=request.encoding,
        max_fps=request.max_fps,
        ice_servers=settings.webrtc_ice_servers,
    )


def create_streamer_app(
    *,
    source_factory: SourceFactory = _real_source_factory,
    peer_factory: PeerFactory = _real_peer_factory,
) -> FastAPI:
    """Build the webrtc_streamer FastAPI app with the registry and routes wired.

    Args:
        source_factory: builds a :class:`FrameSource` per start (tests inject a
            fake that needs no ROS).
        peer_factory: builds a :class:`PeerManager` per start (tests inject a
            fake that needs no aiortc).
    """
    _apply_rtp_packet_max()  # before any PeerConnection packetizes media
    settings = get_settings()
    h264 = h264_available()
    registry = StreamRegistry(
        source_factory,
        peer_factory,
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
        """Root identifying the service."""
        return {"service": SERVICE_NAME}

    @app.post("/stream/start", status_code=201, response_model=StreamStartResponse)
    async def stream_start(request: StreamStartRequest) -> StreamStartResponse:
        if request.encoding is Encoding.h264 and not h264:
            raise ApiError(
                status_code=409,
                code="encoding_unavailable",
                message="H.264 encoding is not available in this build.",
                details={"encoding": request.encoding.value},
            )
        # Source start may block on rclpy spin-up; keep the event loop free.
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
                extra={"component": "webrtc_streamer", "stream_id": sid},
            )


app = create_streamer_app()


def main() -> None:
    """Run the service with uvicorn, binding host/port from config."""
    import uvicorn

    settings = get_settings()
    uvicorn.run(app, host=settings.bind_host, port=settings.webrtc_port)


if __name__ == "__main__":
    main()
