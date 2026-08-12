# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""StreamRegistry: deterministic ids, start dedup, idle reap, offer, stop.

Drives the registry with FakeFrameSource / FakePeerManager (no rclpy / aiortc).
Async registry methods are run via ``asyncio.run`` so no async test plugin is
needed.
"""

from __future__ import annotations

import asyncio

from webrtc_streamer.models import Encoding, StreamStartRequest, StreamState
from webrtc_streamer.peer import FakePeerManager
from webrtc_streamer.registry import StreamRegistry, stream_id_for
from webrtc_streamer.source import FakeFrameSource


class FakeClock:
    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t


def _registry(
    **kwargs: object,
) -> tuple[StreamRegistry, dict[str, FakePeerManager], dict[str, FakeFrameSource]]:
    sources: dict[str, FakeFrameSource] = {}
    peers: dict[str, FakePeerManager] = {}

    def source_factory(request: StreamStartRequest) -> FakeFrameSource:
        src = FakeFrameSource(fps=12.0)
        sources[request.topic] = src
        return src

    def peer_factory(
        request: StreamStartRequest, source: FakeFrameSource
    ) -> FakePeerManager:
        pm = FakePeerManager()
        peers[request.topic] = pm
        return pm

    reg = StreamRegistry(source_factory, peer_factory, **kwargs)  # type: ignore[arg-type]
    return reg, peers, sources


def test_stream_id_is_deterministic_for_topic_and_encoding() -> None:
    a = stream_id_for("/cam/front", Encoding.vp8)
    b = stream_id_for("/cam/front", Encoding.vp8)
    c = stream_id_for("/cam/back", Encoding.vp8)
    assert a == b
    assert a != c
    assert a.startswith("s_")


def test_start_brings_source_up_and_marks_live() -> None:
    reg, _peers, sources = _registry()
    sid = reg.start(StreamStartRequest(topic="/cam/front"))
    assert sid == stream_id_for("/cam/front", Encoding.vp8)
    assert sources["/cam/front"].started is True
    info = next(s for s in reg.status().streams if s.stream_id == sid)
    assert info.state is StreamState.live
    assert info.topic == "/cam/front"
    assert info.fps == 12.0


def test_duplicate_start_returns_existing_stream() -> None:
    reg, _peers, sources = _registry()
    sid1 = reg.start(StreamStartRequest(topic="/cam/front"))
    sid2 = reg.start(StreamStartRequest(topic="/cam/front"))
    assert sid1 == sid2
    # Only one source was created for the topic.
    assert len(sources) == 1
    assert len(reg.stream_ids()) == 1


def test_handle_offer_delegates_to_peer_manager() -> None:
    reg, peers, _sources = _registry()
    sid = reg.start(StreamStartRequest(topic="/cam/front"))
    sdp, sdp_type = asyncio.run(reg.handle_offer(sid, "OFFER", "offer"))
    assert sdp == "answer-for:OFFER"
    assert sdp_type == "answer"
    # The fake peer manager counted the client.
    assert peers["/cam/front"].client_count() == 1


def test_offer_on_unknown_stream_raises_keyerror() -> None:
    reg, _peers, _sources = _registry()
    try:
        asyncio.run(reg.handle_offer("nope", "OFFER", "offer"))
    except KeyError:
        pass
    else:  # pragma: no cover - should not reach
        raise AssertionError("expected KeyError for unknown stream")


def test_stop_tears_down_source_and_peers() -> None:
    reg, peers, sources = _registry()
    sid = reg.start(StreamStartRequest(topic="/cam/front"))
    stopped = asyncio.run(reg.stop(sid))
    assert stopped is True
    assert sources["/cam/front"].started is False
    assert peers["/cam/front"].closed is True
    assert reg.stream_ids() == []
    # Stopping again is a no-op (already gone).
    assert asyncio.run(reg.stop(sid)) is False


def test_idle_stream_reaped_after_timeout() -> None:
    clock = FakeClock()
    reg, _peers, _sources = _registry(idle_timeout_s=60.0, clock=clock)
    sid = reg.start(StreamStartRequest(topic="/cam/front"))

    # Just started (idle_since = 0): not yet expired at t=30.
    clock.t = 30.0
    assert reg.reap_idle() == []
    # At t=61 it has been idle (no clients) for > 60s.
    clock.t = 61.0
    assert reg.reap_idle() == [sid]


def test_connected_clients_prevent_idle_reap() -> None:
    clock = FakeClock()
    reg, peers, _sources = _registry(idle_timeout_s=10.0, clock=clock)
    reg.start(StreamStartRequest(topic="/cam/front"))
    peers["/cam/front"].set_clients(1)  # a client is connected

    clock.t = 100.0  # well past the idle timeout
    assert reg.reap_idle() == []  # not idle while a client is attached


def test_status_reports_h264_capability() -> None:
    reg, _peers, _sources = _registry(h264_supported=True)
    assert reg.status().capabilities.h264 is True
    reg2, _p, _s = _registry(h264_supported=False)
    assert reg2.status().capabilities.h264 is False
