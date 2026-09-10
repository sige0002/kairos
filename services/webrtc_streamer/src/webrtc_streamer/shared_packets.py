# SPDX-License-Identifier: Apache-2.0
"""One paced native encoder; bounded latest packet fanout with keyframe recovery."""

from __future__ import annotations

import asyncio
import fractions
import logging
from typing import Any

from webrtc_streamer.native_source import NativeImageSource
from webrtc_streamer.peer import AiortcPeerManager

logger = logging.getLogger("kairos.webrtc_streamer")


class PacketHub:
    def __init__(self, source: NativeImageSource, fps: int) -> None:
        self.source = source
        self.interval = 1 / fps
        self.clients: dict[object, int] = {}
        self.changed = asyncio.Condition()
        self.wake = asyncio.Event()
        self.latest: tuple[int, bytes, int, bool] | None = None
        self.sequence = 0
        self.keyframe = True
        self.closed = False
        self.failure: BaseException | None = None
        self.task: asyncio.Task[None] | None = None

    def add(self, token: object) -> None:
        self.clients[token] = 500_000
        self.keyframe = True
        self.wake.set()
        if self.task is None:
            self.task = asyncio.create_task(self._run())

    def remove(self, token: object) -> None:
        self.clients.pop(token, None)

    def request_keyframe(self) -> None:
        self.keyframe = True

    def set_bitrate(self, token: object, bitrate: int) -> None:
        if token in self.clients:
            self.clients[token] = max(250_000, min(1_500_000, bitrate))

    async def _run(self) -> None:
        try:
            while not self.closed:
                if not self.clients:
                    self.wake.clear()
                    await self.wake.wait()
                    continue
                start = asyncio.get_running_loop().time()
                key = self.keyframe
                self.keyframe = False
                work = asyncio.create_task(
                    asyncio.to_thread(
                        self.source.next_packet,
                        key,
                        min(self.clients.values()),
                    )
                )
                try:
                    result = await asyncio.shield(work)
                except asyncio.CancelledError:
                    # Join the native call before the registry can destroy its source.
                    await work
                    raise
                if result is not None:
                    self.sequence += 1
                    async with self.changed:
                        self.latest = (self.sequence, *result)
                        self.changed.notify_all()
                elif key:
                    self.keyframe = True
                elapsed = asyncio.get_running_loop().time() - start
                await asyncio.sleep(max(0, self.interval - elapsed))
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.failure = exc
            logger.exception("native shared encoder failed")
        finally:
            async with self.changed:
                self.changed.notify_all()

    async def receive(
        self, sequence: int, needs_key: bool
    ) -> tuple[int, bytes, int, bool]:
        async with self.changed:
            while True:
                if self.closed or self.failure:
                    raise RuntimeError("shared encoder stopped") from self.failure
                packet = self.latest
                if packet and packet[0] > sequence:
                    if needs_key or (sequence > 0 and packet[0] > sequence + 1):
                        if not packet[3]:
                            self.keyframe = True
                            sequence = packet[0]
                            needs_key = True
                            await self.changed.wait()
                            continue
                    return packet
                await self.changed.wait()

    async def close(self) -> None:
        self.closed = True
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass
        async with self.changed:
            self.changed.notify_all()


def packet_track(hub: PacketHub) -> Any:
    from aiortc import MediaStreamTrack
    from aiortc.mediastreams import MediaStreamError
    from av import Packet

    class Track(MediaStreamTrack):
        kind = "video"

        def __init__(self) -> None:
            super().__init__()
            self.sequence = hub.sequence
            self.needs_key = True
            self.registered = False

        async def recv(self) -> Any:
            if self.readyState != "live":
                raise MediaStreamError
            if not self.registered:
                hub.add(self)
                self.registered = True
            try:
                seq, data, pts, _ = await hub.receive(self.sequence, self.needs_key)
            except RuntimeError as exc:
                raise MediaStreamError from exc
            self.sequence, self.needs_key = seq, False
            packet = Packet(data)
            packet.pts = packet.dts = pts
            packet.time_base = fractions.Fraction(1, 90_000)
            return packet

        def stop(self) -> None:
            hub.remove(self)
            super().stop()

    return Track()


class SharedPacketPeerManager(AiortcPeerManager):
    def __init__(
        self, source: NativeImageSource, *, max_fps: int, **kwargs: Any
    ) -> None:
        super().__init__(source.frames, max_fps=max_fps, **kwargs)
        self.hub = PacketHub(source, max_fps)
        self.tracks: set[Any] = set()

    def _make_media_track(self) -> Any:
        track = packet_track(self.hub)
        self.tracks.add(track)
        return track

    def _configure_sender(self, sender: Any) -> None:
        import aiortc
        from aiortc.codecs.vpx import Vp8Encoder

        # Private seam is deliberately version-guarded, limited to this opt-in
        # backend, and tested with real RTCP PLI/REMB. No global monkeypatch.
        if aiortc.__version__ != "1.14.0":
            raise RuntimeError("native shared packets require aiortc 1.14.0")
        hub, token = self.hub, sender.track

        class Packer(Vp8Encoder):
            @property
            def target_bitrate(self) -> int:
                return hub.clients.get(token, 500_000)

            @target_bitrate.setter
            def target_bitrate(self, bitrate: int) -> None:
                hub.set_bitrate(token, bitrate)

        sender._RTCRtpSender__encoder = Packer()
        sender._send_keyframe = hub.request_keyframe

    async def _discard(self, pc: Any) -> None:
        for sender in pc.getSenders():
            if sender.track in self.tracks:
                sender.track.stop()
                self.tracks.discard(sender.track)
        await super()._discard(pc)

    async def close(self) -> None:
        for track in self.tracks:
            track.stop()
        self.tracks.clear()
        await self.hub.close()
        await super().close()
