# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Demand decoding: bounded latest input, shared work, and shutdown safety."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from threading import Event
from unittest.mock import Mock

from webrtc_streamer.frame_decoder import FrameDecoder


def _make_decoder():
    publish = Mock()
    return FrameDecoder(publish), publish


class TestFrameDecoder:
    def test_only_latest_input_is_converted_on_demand(self):
        decoder, publish = _make_decoder()
        convert = Mock(side_effect=lambda value: value * 2)
        for value in range(100):
            decoder.offer(value, convert)
        convert.assert_not_called()
        decoder.prepare()
        convert.assert_called_once_with(99)
        publish.assert_called_once_with(198)
        decoder.prepare()
        convert.assert_called_once()

    def test_concurrent_clients_share_conversion_without_blocking_input(self):
        decoder, publish = _make_decoder()
        entered, release = Event(), Event()

        def convert(value):
            entered.set()
            assert release.wait(2)
            return value

        decoder.offer(1, convert)
        with ThreadPoolExecutor(2) as pool:
            first = pool.submit(decoder.prepare)
            try:
                assert entered.wait(2)
                second = pool.submit(decoder.prepare)
                decoder.offer(2, lambda value: value)
                decoder.offer(3, lambda value: value)
            finally:
                release.set()
            first.result(timeout=2)
            second.result(timeout=2)
        assert [call.args[0] for call in publish.call_args_list] == [1, 3]

    def test_two_clients_requesting_the_same_message_decode_once(self):
        decoder, publish = _make_decoder()
        convert = Mock(return_value="frame")
        decoder.offer("message", convert)
        with ThreadPoolExecutor(4) as pool:
            list(pool.map(lambda _: decoder.prepare(), range(4)))
        convert.assert_called_once()
        publish.assert_called_once_with("frame")

    def test_close_drops_pending_input_and_rejects_late_callbacks(self):
        decoder, publish = _make_decoder()
        convert = Mock()
        decoder.offer(1, convert)
        decoder.close()
        decoder.offer(2, convert)
        decoder.prepare()
        decoder.close()
        convert.assert_not_called()
        publish.assert_not_called()

    def test_close_waits_for_active_decode_without_publishing_after_close(self):
        decoder, publish = _make_decoder()
        entered, release = Event(), Event()

        def convert(value):
            entered.set()
            assert release.wait(2)
            return value

        decoder.offer(1, convert)
        with ThreadPoolExecutor(2) as pool:
            work = pool.submit(decoder.prepare)
            try:
                assert entered.wait(2)
                stopped = pool.submit(decoder.close)
                assert decoder._closed.wait(2)
                assert not stopped.done()
            finally:
                release.set()
            work.result(timeout=2)
            stopped.result(timeout=2)
        publish.assert_not_called()

    def test_bad_frame_logs_once_and_next_frame_recovers(self, caplog):
        decoder, publish = _make_decoder()
        decoder.offer(1, Mock(side_effect=ValueError("bad frame")))
        decoder.prepare()
        decoder.prepare()
        assert caplog.text.count("failed to prepare preview frame") == 1
        decoder.offer(2, lambda value: value)
        decoder.prepare()
        publish.assert_called_once_with(2)
