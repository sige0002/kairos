"""Request/response models for the in-node WebRTC lane.

These shapes are byte-for-byte the ``webrtc_streamer`` HTTP contract
(``/stream/start|stop|status|offer``), so the frontend switches from the
standalone streamer to this dora-hosted lane by pointing nginx's
``WEBRTC_HOST``/``WEBRTC_PORT`` at the node — no frontend change. Kept as a
self-contained copy (dora_live must not depend on the webrtc_streamer package);
any divergence from the streamer contract is a bug. See
``services/webrtc_streamer/src/webrtc_streamer/models.py``.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Annotated

from pydantic import BaseModel, Field


class Encoding(StrEnum):
    """Video codec for a stream (shared vocabulary from config.md).

    ``vp8`` is always available (aiortc bundles a software VP8 encoder).
    ``h264`` depends on the runtime build of PyAV/aiortc and is advertised as a
    capability in ``/stream/status``; a start that requests it when it is not
    available is rejected.
    """

    vp8 = "vp8"
    h264 = "h264"


class StreamState(StrEnum):
    """Lifecycle state of a preview stream.

    ``starting`` -> the source is being brought up; ``live`` -> the source is
    attached to the bus and clients may connect; ``stopping`` -> teardown in
    progress. A stopped stream is removed from the registry rather than parked
    in a terminal state.
    """

    starting = "starting"
    live = "live"
    stopping = "stopping"


class StreamStartRequest(BaseModel):
    """Body of ``POST /stream/start``.

    ``topic`` is the ROS image topic to preview. The remaining fields are
    preview-quality hints: this is a lossy, low-latency path, so they cap
    resource use rather than guarantee exact output. ``stream_id`` is derived
    deterministically from ``topic`` (+ encoding), so a duplicate start for the
    same topic returns the existing stream instead of creating a second one.
    """

    topic: str = Field(min_length=1)
    encoding: Encoding = Encoding.vp8
    # None = "client did not ask" -> the server-side VideoDefaults apply
    # (config-driven; previously a hard 15 baked in here).
    max_fps: Annotated[int, Field(ge=1, le=60)] | None = None
    max_width: Annotated[int, Field(ge=16, le=7680)] | None = None
    max_height: Annotated[int, Field(ge=16, le=4320)] | None = None
    bitrate_kbps: Annotated[int, Field(ge=64, le=50_000)] | None = None


class VideoDefaults(BaseModel):
    """Server-side stream defaults applied when the client omits a field.

    The operator's decode/encode budget lever (LIVE_CONFIG ``video_defaults``):
    the frontend does not pass resolution today, so without a default cap every
    stream decodes AND encodes at the camera's native size — on HD cameras that
    is the dominant CPU cost, not the transport.
    """

    max_fps: Annotated[int, Field(ge=1, le=60)] = 15
    max_width: Annotated[int, Field(ge=16, le=7680)] | None = None
    max_height: Annotated[int, Field(ge=16, le=4320)] | None = None


class StreamStopRequest(BaseModel):
    """Body of ``POST /stream/stop``."""

    stream_id: str = Field(min_length=1)


class StreamStartResponse(BaseModel):
    """Body of a successful ``POST /stream/start``."""

    stream_id: str


class StreamInfo(BaseModel):
    """Per-stream entry in ``GET /stream/status``."""

    stream_id: str
    topic: str
    state: StreamState
    clients: int = 0
    fps: float = 0.0
    encoding: Encoding = Encoding.vp8


class Capabilities(BaseModel):
    """Runtime codec capabilities advertised by ``GET /stream/status``."""

    h264: bool = False


class StreamStatusResponse(BaseModel):
    """Body of ``GET /stream/status``."""

    capabilities: Capabilities
    streams: list[StreamInfo] = Field(default_factory=list)


class SdpModel(BaseModel):
    """A WebRTC SDP description (the ``offer`` in / ``answer`` out)."""

    type: str
    sdp: str


class OfferRequest(BaseModel):
    """Body of ``POST /stream/offer`` (WHEP-style HTTP offer)."""

    stream_id: str = Field(min_length=1)
    sdp: SdpModel


class AnswerResponse(BaseModel):
    """Body of a successful ``POST /stream/offer`` (the SDP answer)."""

    type: str
    sdp: str
