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
            # 1x1 black until the first real frame arrives, so a client that
            # connects before the camera publishes still gets a valid stream.
            self._last = av.VideoFrame(width=2, height=2, format="bgr24")

        async def recv(self) -> Any:
            # Pace to max_fps; recv is awaited in a tight loop by aiortc.
            target = self._start + self._count * interval
            now = time.monotonic()
            if target > now:
                await asyncio.sleep(target - now)
            self._count += 1

            bgr = self._frames.latest_nowait()
            if bgr is not None:
                self._last = av.VideoFrame.from_ndarray(bgr, format="bgr24")
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
    ) -> None:
        self._frames = frames
        self._encoding = encoding
        self._max_fps = max_fps
        self._lock = threading.Lock()
        self._pcs: set[Any] = set()

    def client_count(self) -> int:
        with self._lock:
            return len(self._pcs)

    async def handle_offer(self, sdp: str, sdp_type: str) -> tuple[str, str]:
        from aiortc import RTCConfiguration, RTCPeerConnection, RTCSessionDescription

        # LAN default: no ICE servers (peers are directly reachable). STUN/TURN
        # would be distributed via /api/v1/config only for cross-network use.
        pc = RTCPeerConnection(RTCConfiguration(iceServers=[]))
        with self._lock:
            self._pcs.add(pc)

        @pc.on("connectionstatechange")
        async def _on_state() -> None:
            if pc.connectionState in ("failed", "closed", "disconnected"):
                await self._discard(pc)

        sender = pc.addTrack(_make_track(self._frames, self._max_fps))
        self._force_codec(pc, sender)

        await pc.setRemoteDescription(RTCSessionDescription(sdp=sdp, type=sdp_type))
        answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        # Non-trickle: wait for ICE gathering to complete so the answer carries
        # all candidates (the spec exchanges complete SDP, no trickle channel).
        await self._await_ice_complete(pc)
        local = pc.localDescription
        return local.sdp, local.type

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

        try:
            await asyncio.wait_for(done.wait(), timeout=5.0)
        except TimeoutError:
            # Proceed with whatever candidates we have; LAN connectivity usually
            # works with host candidates alone.
            logger.debug("ICE gathering timed out; sending partial answer")

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
