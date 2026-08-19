# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""The aiortc seam: SDP offer/answer + per-client PeerConnection lifecycle.

One stream shares a single frame source (latest-frame-wins) across clients, but
each client gets its **own** PeerConnection (spec requirement). A
:class:`PeerManager` owns the PeerConnections for one stream: it answers WHEP
offers, counts connected clients, and tears a connection down when its client
disconnects.

The registry depends only on the :class:`PeerManager` Protocol, so its
start/stop/idle/status logic is unit-testable with a :class:`FakePeerManager` —
no real codec or ICE. The real :class:`AiortcPeerManager` imports aiortc / PyAV
lazily so this module imports cleanly where neither is installed.
"""

from __future__ import annotations

import asyncio
import fractions
import logging
import threading
import time
from typing import Any, Protocol, runtime_checkable

from webrtc_streamer.frame_queue import LatestFrame
from webrtc_streamer.models import Encoding

logger = logging.getLogger("kairos.webrtc_streamer")

# Media clock for outgoing VP8/H.264: 90 kHz is the RTP video standard.
_VIDEO_CLOCK_RATE = 90_000

# On connect, wait up to this long for the first camera frame so the stream
# STARTS at the real resolution. Starting with a placeholder frame and then
# changing resolution forces a keyframe the browser must decode — and when that
# is dropped/late, some browsers keep showing the (black) placeholder. Avoiding
# the initial size change removes that intermittent "black preview" entirely.
_FIRST_FRAME_WAIT_S = 3.0
_FIRST_FRAME_POLL_S = 0.02
# Black-frame fallback size when no camera frame arrives in time (a normal
# preview size, not 2x2, so a later first frame is at most a normal resize).
_FALLBACK_W, _FALLBACK_H = 640, 480


@runtime_checkable
class PeerManager(Protocol):
    """Owns the per-client PeerConnections for one stream.

    The registry calls :meth:`handle_offer` for each WHEP offer, reads
    :meth:`client_count` for ``/stream/status``, and :meth:`close` on stop.
    """

    async def handle_offer(self, sdp: str, sdp_type: str) -> tuple[str, str]:
        """Answer a client SDP offer, returning ``(answer_sdp, answer_type)``."""
        ...

    def client_count(self) -> int:
        """Number of currently-connected client PeerConnections."""
        ...

    async def close(self) -> None:
        """Close every PeerConnection for this stream."""
        ...


class FakePeerManager:
    """In-memory :class:`PeerManager` for tests (no aiortc / ICE).

    :meth:`handle_offer` echoes a canned answer and bumps a simulated client
    count; :meth:`set_clients` lets a test model connect/disconnect so the
    registry's idle/status logic can be exercised without real PeerConnections.
    """

    def __init__(self) -> None:
        self._clients = 0
        self.closed = False

    async def handle_offer(self, sdp: str, sdp_type: str) -> tuple[str, str]:
        self._clients += 1
        return (f"answer-for:{sdp}", "answer")

    def client_count(self) -> int:
        return self._clients

    def set_clients(self, count: int) -> None:
        """Directly set the simulated connected-client count."""
        self._clients = count

    async def close(self) -> None:
        self.closed = True
        self._clients = 0


def _should_discard_on_state(state: str) -> bool:
    """Whether an ICE connection *state* warrants tearing down the PeerConnection.

    Only the terminal states ``failed`` / ``closed`` do. ``disconnected`` is a
    TRANSIENT ICE state (a brief network hiccup) that routinely recovers on its
    own to ``connected``; discarding on it would kill the preview on every blip
    and never let it come back (STR-M1). We keep the connection and let ICE
    recover, escalating to a teardown only if it later reaches ``failed``.
    """
    return state in ("failed", "closed")


def drop_ipv6_candidates(sdp: str) -> str:
    """Strip IPv6 ICE candidate lines from an SDP answer.

    Every reachable path we need is IPv4: the LAN host candidates (192.168.x) and
    the Tailscale candidate (100.x). A node's Tailscale IPv6 (``fd7a:…``) is
    redundant with its IPv4 — and fragmented IPv6 datagrams are black-holed over
    WireGuard, so if a browser nominates the v6 pair the (fragmented) media never
    arrives and the preview goes black. Dropping v6 candidates keeps ICE on the
    working v4 path. The streamer always advertises at least one v4 host
    candidate, so this never empties the candidate set. Paired with the
    ``WEBRTC_PACKET_MAX`` cap (see ``main``), which removes fragmentation on v4
    too. Set ``WEBRTC_KEEP_IPV6=1`` to disable (e.g. a genuinely v6-only network).
    """
    import os

    if os.getenv("WEBRTC_KEEP_IPV6") == "1":
        return sdp
    trailing = "\r\n" if sdp.endswith("\n") else ""
    kept: list[str] = []
    for line in sdp.splitlines():
        body = line[2:] if line.startswith("a=") else line
        if body.startswith("candidate:"):
            # a=candidate:<foundation> <comp> <transport> <prio> <ip> <port> typ …
            parts = body.split()
            if len(parts) >= 5 and ":" in parts[4]:
                continue  # IPv6 connection address -> drop this candidate
        kept.append(line)
    return "\r\n".join(kept) + trailing


def h264_available() -> bool:
    """Whether the runtime aiortc/PyAV build can encode H.264.

    H.264 support depends on how PyAV's bundled FFmpeg was built; VP8 is always
    present. Reported as a capability in ``/stream/status`` so the frontend can
    offer the option only when it will actually work. Returns ``False`` if
    aiortc is not installed at all (the unit-test environment).
    """
    try:
        from aiortc.codecs import get_capabilities
    except Exception:  # noqa: BLE001 - aiortc absent or import error => no H.264
        return False
    try:
        caps = get_capabilities("video")
    except Exception:  # noqa: BLE001
        return False
    return any("h264" in (codec.mimeType or "").lower() for codec in caps.codecs)


class _BgrVideoTrack:
    """An aiortc ``VideoStreamTrack`` fed from a :class:`LatestFrame`.

    Pulls the freshest BGR frame each tick (dropping anything older), wraps it
    in a PyAV ``VideoFrame``, and paces output at ``max_fps``. Defined as a
    plain class with a lazy base so importing this module needs no aiortc; the
    real base is attached in :func:`_make_track`.
    """

    # Filled in by _make_track(); kept here for type-checkers / readability.
    pass


def _make_track(frames: LatestFrame[Any], max_fps: int) -> Any:
    """Build a live aiortc video track over *frames* (aiortc imported here)."""
    import av
    from aiortc import VideoStreamTrack

    interval = 1.0 / max(1, max_fps)

    class BgrVideoTrack(VideoStreamTrack):
        kind = "video"

        def __init__(self) -> None:
            super().__init__()
            self._frames = frames
            self._start = time.monotonic()
            self._count = 0
            # No placeholder yet: the first recv() waits for a real camera frame
            # so the stream STARTS at the real resolution (see _FIRST_FRAME_WAIT_S).
            self._last: Any = None

        async def _first_bgr(self) -> Any:
            """Wait (briefly) for the first camera frame, so the stream starts at
            the real resolution instead of a placeholder size that later resizes."""
            deadline = time.monotonic() + _FIRST_FRAME_WAIT_S
            while True:
                bgr = self._frames.latest_nowait()
                if bgr is not None or time.monotonic() >= deadline:
                    return bgr
                await asyncio.sleep(_FIRST_FRAME_POLL_S)

        async def recv(self) -> Any:
            # Pace to max_fps; recv is awaited in a tight loop by aiortc.
            target = self._start + self._count * interval
            now = time.monotonic()
            if target > now:
                await asyncio.sleep(target - now)
            self._count += 1

            bgr = self._frames.latest_nowait()
            if bgr is None and self._last is None:
                # First frame not seen yet: wait so we never emit a placeholder
                # that the real frame would resize (the resize-keyframe glitch).
                bgr = await self._first_bgr()
            if bgr is not None:
                self._last = av.VideoFrame.from_ndarray(bgr, format="bgr24")
            elif self._last is None:
                # Camera still silent after the wait: a normal-size black frame
                # keeps the stream valid (a later first frame is at most a resize).
                self._last = av.VideoFrame(
                    width=_FALLBACK_W, height=_FALLBACK_H, format="bgr24"
                )
            frame = self._last
            # Stamp the frame with a 90 kHz presentation timestamp.
            pts = int((time.monotonic() - self._start) * _VIDEO_CLOCK_RATE)
            frame.pts = pts
            frame.time_base = fractions.Fraction(1, _VIDEO_CLOCK_RATE)
            return frame

    return BgrVideoTrack()


class AiortcPeerManager:
    """aiortc-backed :class:`PeerManager` for one stream.

    Each :meth:`handle_offer` creates a fresh ``RTCPeerConnection`` (one per
    client), adds a track sharing this stream's frame buffer, forces the
    requested codec, and returns the SDP answer. A connection-state listener
    removes a PeerConnection when its client disconnects, which is what keeps
    ``client_count`` (and the idle auto-stop) honest.
    """

    def __init__(
        self,
        frames: LatestFrame[Any],
        *,
        encoding: Encoding = Encoding.vp8,
        max_fps: int = 15,
        ice_servers: list[dict[str, Any]] | None = None,
    ) -> None:
        self._frames = frames
        self._encoding = encoding
        self._max_fps = max_fps
        # RTCIceServer JSON dicts (from WEBRTC_ICE_SERVERS via config). Empty =
        # LAN/direct, host candidates only. Kept raw; turned into RTCIceServer
        # objects lazily in handle_offer so this module imports without aiortc.
        self._ice_server_cfgs = ice_servers or []
        self._lock = threading.Lock()
        self._pcs: set[Any] = set()

    def _build_ice_servers(self) -> list[Any]:
        """Turn the configured RTCIceServer dicts into aiortc ``RTCIceServer``s.

        Skips entries without ``urls`` so a partial/malformed config degrades to
        fewer (or no) ICE servers rather than failing the offer.
        """
        from aiortc import RTCIceServer

        servers: list[Any] = []
        for entry in self._ice_server_cfgs:
            if not isinstance(entry, dict):
                continue
            urls = entry.get("urls")
            if not urls:
                continue
            servers.append(
                RTCIceServer(
                    urls=urls,
                    username=entry.get("username"),
                    credential=entry.get("credential"),
                )
            )
        return servers

    def client_count(self) -> int:
        with self._lock:
            return len(self._pcs)

    async def handle_offer(self, sdp: str, sdp_type: str) -> tuple[str, str]:
        from aiortc import RTCConfiguration, RTCPeerConnection, RTCSessionDescription

        # STUN/TURN come from WEBRTC_ICE_SERVERS (the same RTCIceServer JSON the
        # browser gets via /api/v1/config), so both peers agree. Empty [] = LAN/
        # direct with host candidates only (unchanged default behavior).
        pc = RTCPeerConnection(RTCConfiguration(iceServers=self._build_ice_servers()))
        with self._lock:
            self._pcs.add(pc)
        try:

            @pc.on("connectionstatechange")
            async def _on_state() -> None:
                state = pc.connectionState
                if _should_discard_on_state(state):
                    await self._discard(pc)
                elif state == "disconnected":
                    # Transient: log and wait for ICE to recover (STR-M1); do not
                    # discard, or a momentary blip would end the preview for good.
                    logger.info("peer transiently disconnected; awaiting ICE recovery")

            sender = pc.addTrack(_make_track(self._frames, self._max_fps))
            self._force_codec(pc, sender)

            await pc.setRemoteDescription(RTCSessionDescription(sdp=sdp, type=sdp_type))
            answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)
            # Non-trickle: wait for ICE gathering to complete so the answer carries
            # all candidates (the spec exchanges complete SDP, no trickle channel).
            await self._await_ice_complete(pc)
            local = pc.localDescription
            return drop_ipv6_candidates(local.sdp), local.type
        except BaseException:
            # SDP validation, codec setup, ICE gathering and cancellation all
            # happen after registry insertion. A failed offer owns no usable
            # client, so close and forget it before propagating the failure.
            await self._discard(pc)
            raise

    def _force_codec(self, pc: Any, sender: Any) -> None:
        """Restrict the sender to the requested codec, if the API allows it."""
        try:
            from aiortc.rtcrtpsender import RTCRtpSender

            mime = f"video/{'H264' if self._encoding is Encoding.h264 else 'VP8'}"
            caps = RTCRtpSender.getCapabilities("video")
            wanted = [c for c in caps.codecs if c.mimeType.lower() == mime.lower()]
            if not wanted:
                return
            for transceiver in pc.getTransceivers():
                if transceiver.sender is sender:
                    transceiver.setCodecPreferences(wanted)
        except Exception:  # noqa: BLE001 - codec pinning is best-effort
            logger.debug("could not pin codec %s", self._encoding, exc_info=True)

    @staticmethod
    async def _await_ice_complete(pc: Any) -> None:
        if pc.iceGatheringState == "complete":
            return
        done = asyncio.Event()

        @pc.on("icegatheringstatechange")
        async def _check() -> None:
            if pc.iceGatheringState == "complete":
                done.set()

        # The fixed 5 s was a LAN assumption (timing sweep S4): a TURN
        # allocation over a slow uplink can take longer, and a partial answer
        # missing its relay candidate is the "connected but black preview"
        # family. Tunable so a TURN deployment can raise it; the LAN default
        # stays snappy.
        import os

        try:
            timeout_s = float(os.getenv("WEBRTC_ICE_GATHER_TIMEOUT_S", "5.0"))
        except ValueError:
            timeout_s = 5.0
        try:
            await asyncio.wait_for(done.wait(), timeout=timeout_s)
        except TimeoutError:
            # Proceed with whatever candidates we have; LAN connectivity usually
            # works with host candidates alone. Logged at WARNING when ICE
            # servers are configured — there, a partial answer is the likely
            # cause of a black preview, and debug-level silence hid it.
            logger.warning(
                "ICE gathering did not complete within %.1fs; sending a "
                "partial answer (set WEBRTC_ICE_GATHER_TIMEOUT_S to wait "
                "longer, e.g. behind TURN)",
                timeout_s,
            )

    async def _discard(self, pc: Any) -> None:
        with self._lock:
            if pc not in self._pcs:
                return
            self._pcs.discard(pc)
        try:
            await pc.close()
        except Exception:  # noqa: BLE001 - already closing
            pass

    async def close(self) -> None:
        with self._lock:
            pcs = list(self._pcs)
            self._pcs.clear()
        for pc in pcs:
            try:
                await pc.close()
            except Exception:  # noqa: BLE001
                pass
