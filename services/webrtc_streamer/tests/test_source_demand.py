# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Source/track wiring with real image conversion, without a ROS installation."""

import asyncio
import threading
from types import SimpleNamespace
from unittest.mock import Mock

import numpy as np
import pytest
from webrtc_streamer import convert
from webrtc_streamer.peer import _make_track
from webrtc_streamer.source import RosImageSource


@pytest.mark.parametrize("compressed", [False, True])
def test_source_defers_decode_and_resize_until_a_consumer_requests(
    monkeypatch, compressed
):
    source = RosImageSource("/cam/image", max_width=2)
    image = np.ones((4, 4, 3), dtype=np.uint8)
    decode = Mock(return_value=image)
    method = "compressed_image_to_bgr" if compressed else "image_to_bgr"
    monkeypatch.setattr(convert, method, decode)
    callback = source._on_compressed if compressed else source._on_image
    for value in range(4):
        callback(value)
    decode.assert_not_called()
    assert source.frames.latest_nowait() is None
    source.prepare_frame()
    decode.assert_called_once_with(3)
    assert source.frames.latest_nowait().shape == (2, 2, 3)
    source.prepare_frame()
    decode.assert_called_once()
    source.stop()
    callback(5)
    source.prepare_frame()
    decode.assert_called_once()


def test_track_requests_decode_off_event_loop_and_reuses_last_source_frame(monkeypatch):
    async def scenario():
        source = RosImageSource("/cam/image")
        decode_threads = []

        def decode(_msg):
            decode_threads.append(threading.get_ident())
            return np.ones((8, 8, 3), dtype=np.uint8)

        monkeypatch.setattr(convert, "image_to_bgr", decode)
        track = _make_track(source.frames, 60, source.prepare_frame)
        source._on_image(SimpleNamespace())
        first = await asyncio.wait_for(track.recv(), 2)
        second = await asyncio.wait_for(track.recv(), 2)
        assert first.width == second.width == 8
        assert second.pts > first.pts
        assert len(decode_threads) == 1
        assert decode_threads[0] != threading.get_ident()
        track.stop()
        await asyncio.to_thread(source.stop)

    asyncio.run(scenario())


def test_first_track_frame_waits_for_real_input(monkeypatch):
    async def scenario():
        source = RosImageSource("/cam/image")
        monkeypatch.setattr(
            convert, "image_to_bgr", lambda _: np.zeros((12, 16, 3), dtype=np.uint8)
        )
        requested = asyncio.Event()
        original = source.prepare_frame
        loop = asyncio.get_running_loop()

        def prepare():
            original()
            loop.call_soon_threadsafe(requested.set)

        track = _make_track(source.frames, 15, prepare)
        pending = asyncio.create_task(track.recv())
        await asyncio.wait_for(requested.wait(), 2)
        assert not pending.done()
        source._on_image(object())
        frame = await asyncio.wait_for(pending, 2)
        assert (frame.width, frame.height) == (16, 12)
        track.stop()
        await asyncio.to_thread(source.stop)

    asyncio.run(scenario())


def test_stop_before_start_does_not_disable_the_first_real_start(monkeypatch):
    source = RosImageSource("/cam/image")
    source.stop()
    monkeypatch.setattr(source, "_spin_up", lambda: None)
    monkeypatch.setattr(
        convert, "image_to_bgr", lambda _: np.zeros((4, 4, 3), dtype=np.uint8)
    )
    source.start()
    source._on_image(object())
    source.prepare_frame()
    assert source.frames.latest_nowait() is not None
    source.stop()
