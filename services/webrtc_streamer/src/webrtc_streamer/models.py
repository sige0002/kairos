# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Request/response models and the stream state enum for webrtc_streamer.

These shapes are the streamer's public HTTP contract. The frontend calls
``/stream/start|stop|status`` and exchanges SDP via ``/stream/offer`` directly
(``WEBRTC_PUBLIC_URL``), so they are pydantic models and the OpenAPI schema is
generated from them. See ``docs/specs/ja/webrtc_streamer.md``.
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

    ``starting`` -> the ROS source is being brought up; ``live`` -> the source
    is delivering frames and clients may connect; ``stopping`` -> teardown in
    progress. The registry drives a stream through these; a stopped stream is
    simply removed from the registry rather than parked in a terminal state.
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
    max_fps: Annotated[int, Field(ge=1, le=60)] = 15
    max_width: Annotated[int, Field(ge=16, le=7680)] | None = None
    max_height: Annotated[int, Field(ge=16, le=4320)] | None = None
    bitrate_kbps: Annotated[int, Field(ge=64, le=50_000)] | None = None


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
