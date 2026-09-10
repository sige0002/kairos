# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import asyncio
import threading

import pytest
from webrtc_streamer.shared_packets import PacketHub, packet_track


class Source:
    def __init__(self) -> None:
        self.calls: list[tuple[bool, int]] = []

    def next_packet(self, key: bool, bitrate: int) -> tuple[bytes, int, bool]:
        self.calls.append((key, bitrate))
        return b"encoded", len(self.calls) * 6000, key


def test_two_clients_share_one_encode_and_late_join_requests_keyframe() -> None:
    async def run() -> None:
        source = Source()
        hub = PacketHub(source, 15)
        a, b = packet_track(hub), packet_track(hub)
        try:
            first, second = await asyncio.wait_for(
                asyncio.gather(a.recv(), b.recv()),
                2,
            )
            assert first.pts == second.pts
            assert len(source.calls) == 1
            assert source.calls[0][0] is True
            c = packet_track(hub)
            third = await asyncio.wait_for(c.recv(), 2)
            assert third.pts > first.pts
            assert source.calls[-1][0] is True
            c.stop()
            hub.set_bitrate(a, 300_000)
            hub.set_bitrate(b, 1_000_000)
            await a.recv()  # Consume the keyframe produced for the late joiner.
            await a.recv()
            assert source.calls[-1][1] == 300_000
            a.stop()
            await b.recv()  # May consume the already-produced packet.
            await b.recv()
            assert source.calls[-1][1] == 1_000_000
        finally:
            a.stop()
            b.stop()
            await hub.close()

    asyncio.run(run())


def test_slow_client_skips_to_keyframe_with_bounded_storage() -> None:
    async def run() -> None:
        hub = PacketHub(Source(), 15)
        hub.latest = (3, b"delta", 18000, False)
        waiter = asyncio.create_task(hub.receive(1, False))
        await asyncio.sleep(0)
        assert hub.keyframe
        assert not waiter.done()
        async with hub.changed:
            hub.latest = (4, b"key", 24000, True)
            hub.changed.notify_all()
        assert (await asyncio.wait_for(waiter, 1))[1] == b"key"
        await hub.close()

    asyncio.run(run())


def test_close_joins_inflight_native_call_and_wakes_receivers() -> None:
    entered, release = threading.Event(), threading.Event()

    class BlockingSource(Source):
        def next_packet(self, key: bool, bitrate: int) -> tuple[bytes, int, bool]:
            entered.set()
            assert release.wait(3)
            return super().next_packet(key, bitrate)

    async def run() -> None:
        hub = PacketHub(BlockingSource(), 15)
        hub.add(object())
        assert await asyncio.to_thread(entered.wait, 2)
        waiter = asyncio.create_task(hub.receive(0, True))
        close = asyncio.create_task(hub.close())
        await asyncio.sleep(0.02)
        assert not close.done()
        release.set()
        await asyncio.wait_for(close, 1)
        with pytest.raises(RuntimeError, match="stopped"):
            await waiter

    asyncio.run(run())


def test_no_consumers_stops_encoding_and_failure_reaches_receivers() -> None:
    async def run() -> None:
        source = Source()
        hub = PacketHub(source, 15)
        token = object()
        hub.add(token)
        await hub.receive(0, True)
        hub.remove(token)
        count = len(source.calls)
        await asyncio.sleep(0.15)
        assert len(source.calls) == count
        await hub.close()

    asyncio.run(run())
