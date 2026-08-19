# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Failure-path lifecycle tests that do not require ROS 2 or aiortc."""

from __future__ import annotations

import asyncio
import sys
from types import SimpleNamespace

import pytest
import webrtc_streamer.peer as peer_module
from webrtc_streamer.frame_queue import LatestFrame
from webrtc_streamer.models import Encoding
from webrtc_streamer.peer import AiortcPeerManager
from webrtc_streamer.source import RosImageSource


class _LifecycleObject:
    def __init__(self) -> None:
        self.cleaned = False

    def shutdown(self) -> None:
        self.cleaned = True

    def destroy_node(self) -> None:
        self.cleaned = True


class _Thread:
    def __init__(self) -> None:
        self.joined = False

    def is_alive(self) -> bool:
        return True

    def join(self, timeout: float) -> None:
        assert timeout == 2.0
        self.joined = True


def test_ros_source_failed_start_cleans_partial_resources_and_can_retry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = RosImageSource("/cam/front")
    node = _LifecycleObject()
    executor = _LifecycleObject()
    thread = _Thread()

    def fail_after_allocation() -> None:
        source._node = node
        source._executor = executor
        source._thread = thread  # type: ignore[assignment]
        raise RuntimeError("subscription creation failed")

    monkeypatch.setattr(source, "_spin_up", fail_after_allocation)
    with pytest.raises(RuntimeError, match="subscription creation failed"):
        source.start()

    assert source._started is False
    assert source._node is None
    assert source._executor is None
    assert source._thread is None
    assert node.cleaned is True
    assert executor.cleaned is True
    assert thread.joined is True

    monkeypatch.setattr(source, "_spin_up", lambda: None)
    source.start()
    assert source._started is True


def test_offer_failure_closes_and_forgets_peer_connection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    created: list[object] = []

    class FakePeerConnection:
        connectionState = "new"
        iceGatheringState = "complete"

        def __init__(self, _configuration: object) -> None:
            self.closed = False
            created.append(self)

        def on(self, _event: str):
            return lambda callback: callback

        def addTrack(self, _track: object) -> object:
            return object()

        def getTransceivers(self) -> list[object]:
            return []

        async def setRemoteDescription(self, _description: object) -> None:
            raise RuntimeError("invalid offer")

        async def close(self) -> None:
            self.closed = True

    fake_aiortc = SimpleNamespace(
        RTCConfiguration=lambda **kwargs: kwargs,
        RTCPeerConnection=FakePeerConnection,
        RTCSessionDescription=lambda **kwargs: kwargs,
        RTCIceServer=lambda **kwargs: kwargs,
    )
    monkeypatch.setitem(sys.modules, "aiortc", fake_aiortc)
    monkeypatch.setattr(peer_module, "_make_track", lambda *_args: object())

    manager = AiortcPeerManager(LatestFrame(), encoding=Encoding.vp8)
    with pytest.raises(RuntimeError, match="invalid offer"):
        asyncio.run(manager.handle_offer("bad", "offer"))

    assert manager.client_count() == 0
    assert len(created) == 1
    assert created[0].closed is True  # type: ignore[attr-defined]
