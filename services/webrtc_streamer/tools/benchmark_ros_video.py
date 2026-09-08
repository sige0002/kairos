# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Isolated ROS -> real aiortc loopback comparison; never use a hardware domain.

Run the same script/image with PYTHONPATH selecting baseline or candidate.
CPU covers this entire test process (publisher, source, encoder, receiver).
Frame age uses a sequence barcode carried through JPEG and VP8, not RTT/2.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import statistics
import time

import cv2
import numpy as np
import rclpy
from aiortc import RTCConfiguration, RTCPeerConnection
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import CompressedImage
from webrtc_streamer import convert
from webrtc_streamer.peer import _make_track
from webrtc_streamer.source import RosImageSource


async def main() -> None:
    cv2.setNumThreads(1)
    topic = "/benchmark/image/compressed"
    # Decode cost is real; fixture generation/compression is outside the window.
    rng = np.random.default_rng(20260908)
    background = rng.integers(0, 256, (1080, 1920, 3), dtype=np.uint8)
    fixtures = []
    for seq in range(256):
        image = background.copy()
        for bit in range(8):
            image[:160, bit * 160 : (bit + 1) * 160] = 255 if seq & (1 << bit) else 0
        ok, jpeg = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 85])
        assert ok
        fixtures.append(jpeg.tobytes())
    rclpy.init()
    node = Node("video_benchmark_publisher")
    publisher = node.create_publisher(CompressedImage, topic, qos_profile_sensor_data)
    source = RosImageSource(topic, max_width=854)
    sender = RTCPeerConnection(RTCConfiguration(iceServers=[]))
    receiver = RTCPeerConnection(RTCConfiguration(iceServers=[]))
    source.start()
    sent_at = {}
    measured_ages = []
    received_times = []
    decode_calls = 0
    decode_ns = 0
    original = convert.compressed_image_to_bgr

    def decode(msg):
        nonlocal decode_calls, decode_ns
        started = time.thread_time_ns()
        result = original(msg)
        decode_ns += time.thread_time_ns() - started
        decode_calls += 1
        return result

    convert.compressed_image_to_bgr = decode
    tasks = []
    started_measurement = None
    cpu_start = 0.0
    count_start = 0
    decode_start = 0
    sequence = 0
    last_received = asyncio.Event()

    async def publish():
        nonlocal sequence
        begin = time.monotonic()
        while True:
            await asyncio.sleep(max(0, begin + sequence / 30 - time.monotonic()))
            stamp = time.monotonic()
            sent_at[sequence % 256] = stamp
            msg = CompressedImage(format="jpeg", data=fixtures[sequence % 256])
            publisher.publish(msg)
            sequence += 1

    @receiver.on("track")
    def on_track(track):
        async def consume():
            while True:
                frame = await track.recv()
                now = time.monotonic()
                pixels = frame.to_ndarray(format="bgr24")
                scale = frame.width / 1920
                seq = sum(
                    (1 << bit)
                    for bit in range(8)
                    if pixels[int(80 * scale), int((bit * 160 + 80) * scale)].mean()
                    > 128
                )
                if started_measurement is not None:
                    assert seq in sent_at, f"corrupt sequence barcode: {seq}"
                    measured_ages.append((now - sent_at[seq]) * 1000)
                    received_times.append(now)
                last_received.set()

        tasks.append(asyncio.create_task(consume()))

    try:
        deadline = time.monotonic() + 10
        while publisher.get_subscription_count() == 0:
            assert time.monotonic() < deadline, "DDS discovery timed out"
            await asyncio.sleep(0.01)
        tasks.append(asyncio.create_task(publish()))
        prepare = getattr(source, "prepare_frame", None)
        if "prepare_frame" in inspect.signature(_make_track).parameters:
            track = _make_track(source.frames, 15, prepare)
        else:
            track = _make_track(source.frames, 15)
        sender.addTrack(track)
        # Match production's default codec explicitly.
        from aiortc import RTCRtpSender

        codecs = [
            c
            for c in RTCRtpSender.getCapabilities("video").codecs
            if c.mimeType == "video/VP8"
        ]
        sender.getTransceivers()[0].setCodecPreferences(codecs)
        await sender.setLocalDescription(await sender.createOffer())
        await receiver.setRemoteDescription(sender.localDescription)
        await receiver.setLocalDescription(await receiver.createAnswer())
        await sender.setRemoteDescription(receiver.localDescription)
        await asyncio.wait_for(last_received.wait(), 15)
        # Start measurement on actual received media, never on a fixed startup sleep.
        started_measurement = time.monotonic()
        cpu_start = time.process_time()
        count_start, decode_start = decode_calls, decode_ns
        await asyncio.sleep(6)
        elapsed = time.monotonic() - started_measurement
        cpu = time.process_time() - cpu_start
        assert len(received_times) >= 60, (
            f"too few received frames: {len(received_times)}"
        )
        ordered = sorted(measured_ages)
        print(
            json.dumps(
                {
                    "input_hz": 30,
                    "display_hz": 15,
                    "input_size": [1920, 1080],
                    "output_width": 854,
                    "elapsed_s": elapsed,
                    "process_cpu_s": cpu,
                    "process_cpu_percent_one_core": 100 * cpu / elapsed,
                    "decode_calls": decode_calls - count_start,
                    "decode_thread_cpu_ms": (decode_ns - decode_start) / 1e6,
                    "received_frames": len(received_times),
                    "received_fps": (len(received_times) - 1)
                    / (received_times[-1] - received_times[0]),
                    "frame_age_median_ms": statistics.median(measured_ages),
                    "frame_age_p95_ms": ordered[int((len(ordered) - 1) * 0.95)],
                    "source_received_fps": source.fps,
                }
            )
        )
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await sender.close()
        await receiver.close()
        await asyncio.to_thread(source.stop)
        node.destroy_node()
        rclpy.shutdown()
        convert.compressed_image_to_bgr = original


if __name__ == "__main__":
    asyncio.run(main())
