# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""StreamRegistry: deterministic ids, start dedup, idle reap, offer, stop.

Drives the registry with FakeFrameSource / FakePeerManager (no rclpy / aiortc).
Async registry methods are run via ``asyncio.run`` so no async test plugin is
needed.
"""

from __future__ import annotations

import asyncio
import threading

import pytest
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
    sid = asyncio.run(reg.start(StreamStartRequest(topic="/cam/front")))
    assert sid == stream_id_for("/cam/front", Encoding.vp8)
    assert sources["/cam/front"].started is True
    info = next(s for s in reg.status().streams if s.stream_id == sid)
    assert info.state is StreamState.live
    assert info.topic == "/cam/front"
    assert info.fps == 12.0


def test_duplicate_start_returns_existing_stream() -> None:
    reg, _peers, sources = _registry()
    sid1 = asyncio.run(reg.start(StreamStartRequest(topic="/cam/front")))
    sid2 = asyncio.run(reg.start(StreamStartRequest(topic="/cam/front")))
    assert sid1 == sid2
    # Only one source was created for the topic.
    assert len(sources) == 1
    assert len(reg.stream_ids()) == 1


def test_handle_offer_delegates_to_peer_manager() -> None:
    reg, peers, _sources = _registry()
    sid = asyncio.run(reg.start(StreamStartRequest(topic="/cam/front")))
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
    sid = asyncio.run(reg.start(StreamStartRequest(topic="/cam/front")))
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
    sid = asyncio.run(reg.start(StreamStartRequest(topic="/cam/front")))

    # Just started (idle_since = 0): not yet expired at t=30.
    clock.t = 30.0
    assert reg.reap_idle() == []
    # At t=61 it has been idle (no clients) for > 60s.
    clock.t = 61.0
    assert reg.reap_idle() == [sid]


def test_connected_clients_prevent_idle_reap() -> None:
    clock = FakeClock()
    reg, peers, _sources = _registry(idle_timeout_s=10.0, clock=clock)
    asyncio.run(reg.start(StreamStartRequest(topic="/cam/front")))
    peers["/cam/front"].set_clients(1)  # a client is connected

    clock.t = 100.0  # well past the idle timeout
    assert reg.reap_idle() == []  # not idle while a client is attached


def test_status_reports_h264_capability() -> None:
    reg, _peers, _sources = _registry(h264_supported=True)
    assert reg.status().capabilities.h264 is True
    reg2, _p, _s = _registry(h264_supported=False)
    assert reg2.status().capabilities.h264 is False


def test_failed_start_rolls_back_and_a_later_start_can_retry() -> None:
    attempts: list[FakeFrameSource] = []
    peers: list[FakePeerManager] = []

    class FailOnceSource(FakeFrameSource):
        def start(self) -> None:
            super().start()
            if len(attempts) == 1:
                raise RuntimeError("camera unavailable")

    def source_factory(_request: StreamStartRequest) -> FakeFrameSource:
        source = FailOnceSource()
        attempts.append(source)
        return source

    def peer_factory(
        _request: StreamStartRequest, _source: FakeFrameSource
    ) -> FakePeerManager:
        peer = FakePeerManager()
        peers.append(peer)
        return peer

    reg = StreamRegistry(source_factory, peer_factory)
    request = StreamStartRequest(topic="/cam/front")

    with pytest.raises(RuntimeError, match="camera unavailable"):
        asyncio.run(reg.start(request))

    assert reg.stream_ids() == []
    assert attempts[0].started is False
    assert peers[0].closed is True

    sid = asyncio.run(reg.start(request))
    assert sid == stream_id_for("/cam/front", Encoding.vp8)
    assert len(attempts) == 2
    assert attempts[1].started is True


def test_stop_during_start_waits_for_rollback_and_never_publishes_live() -> None:
    entered = threading.Event()
    release = threading.Event()
    source = FakeFrameSource()
    peer = FakePeerManager()

    def blocking_start() -> None:
        source._started = True
        entered.set()
        assert release.wait(timeout=2.0)

    source.start = blocking_start  # type: ignore[method-assign]
    reg = StreamRegistry(lambda _request: source, lambda _request, _source: peer)
    request = StreamStartRequest(topic="/cam/front")
    sid = stream_id_for(request.topic, request.encoding)

    async def exercise() -> None:
        start_task = asyncio.create_task(reg.start(request))
        assert await asyncio.to_thread(entered.wait, 2.0)
        stop_task = asyncio.create_task(reg.stop(sid))
        await asyncio.sleep(0)
        release.set()
        assert await stop_task is True
        with pytest.raises(RuntimeError, match="stopped while starting"):
            await start_task

    asyncio.run(exercise())
    assert reg.stream_ids() == []
    assert source.started is False
    assert peer.closed is True


def test_stop_attempts_source_cleanup_when_peer_cleanup_fails() -> None:
    class FailingPeer(FakePeerManager):
        async def close(self) -> None:
            self.closed = True
            raise RuntimeError("peer cleanup failed")

    source = FakeFrameSource()
    peer = FailingPeer()
    reg = StreamRegistry(lambda _request: source, lambda _request, _source: peer)

    async def exercise() -> None:
        sid = await reg.start(StreamStartRequest(topic="/cam/front"))
        with pytest.raises(RuntimeError, match="peer cleanup failed"):
            await reg.stop(sid)

    asyncio.run(exercise())
    assert source.started is False
    assert peer.closed is True
    assert reg.stream_ids() == []


def test_start_cannot_overlap_cleanup_of_same_stream() -> None:
    close_entered = asyncio.Event()
    release_close = asyncio.Event()
    sources: list[FakeFrameSource] = []

    class BlockingPeer(FakePeerManager):
        async def close(self) -> None:
            close_entered.set()
            await release_close.wait()
            await super().close()

    def source_factory(_request: StreamStartRequest) -> FakeFrameSource:
        source = FakeFrameSource()
        sources.append(source)
        return source

    reg = StreamRegistry(source_factory, lambda _request, _source: BlockingPeer())
    request = StreamStartRequest(topic="/cam/front")

    async def exercise() -> None:
        sid = await reg.start(request)
        stop_task = asyncio.create_task(reg.stop(sid))
        await close_entered.wait()

        blocked_start = asyncio.create_task(reg.start(request))
        await asyncio.sleep(0)
        assert len(sources) == 1
        release_close.set()
        assert await stop_task is True
        with pytest.raises(RuntimeError, match="retry after stop completes"):
            await blocked_start

        await reg.start(request)

    asyncio.run(exercise())
    assert len(sources) == 2
