"""Packaged native library: real ROS, decode fidelity, keyframes and lifecycle."""

import asyncio
import fractions
import time

import av
import cv2
import numpy as np
import rclpy
from aiortc import RTCPeerConnection
from aiortc.codecs.vpx import Vp8Encoder, VpxPayloadDescriptor
from aiortc.rtp import RTCP_PSFB_APP, RTCP_PSFB_PLI, RtcpPsfbPacket, pack_remb_fci
from sensor_msgs.msg import CompressedImage, Image
from webrtc_streamer.frame_queue import LatestFrame
from webrtc_streamer.native_source import NativeImageSource
from webrtc_streamer.shared_packets import SharedPacketPeerManager


def wait_for(predicate, timeout=8):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        result = predicate()
        if result:
            return result
        time.sleep(0.03)
    raise AssertionError("timed out waiting for native receive/discovery")


def decode(data):
    decoder = av.CodecContext.create("vp8", "r")
    frames = decoder.decode(av.Packet(data))
    assert len(frames) == 1
    return frames[0].to_ndarray(format="bgr24")


def psnr(a, b):
    mse = np.mean((a.astype(float) - b.astype(float)) ** 2)
    return 10 * np.log10(255**2 / max(mse, 1e-9))


def verify_media():
    rclpy.init()
    node = rclpy.create_node("native_preview_test")
    yy, xx = np.mgrid[:240, :320]
    pixels = np.stack((xx % 256, yy % 256, (xx + yy) % 256), axis=-1).astype(np.uint8)
    results = []
    try:
        for compressed in (True, False):
            topic = "/test/native_compressed" if compressed else "/test/native_raw"
            publisher = node.create_publisher(
                CompressedImage if compressed else Image, topic, 10
            )
            source = NativeImageSource(topic, max_width=320, max_height=240, max_fps=15)
            try:
                for cycle in range(2):
                    source.start()
                    wait_for(lambda p=publisher: p.get_subscription_count() > 0)
                    if compressed:
                        _, jpeg = cv2.imencode(".jpg", pixels)
                        msg = CompressedImage(format="jpeg", data=jpeg.tobytes())
                        expected = cv2.imdecode(jpeg, cv2.IMREAD_COLOR)
                    else:
                        msg = Image(
                            height=240,
                            width=320,
                            encoding="bgr8",
                            step=960,
                            data=pixels.tobytes(),
                        )
                        expected = pixels
                    for _ in range(4):
                        publisher.publish(msg)
                        time.sleep(0.04)
                    wait_for(lambda s=source: s.processing["received"] >= 1)
                    packet = wait_for(lambda s=source: s.next_packet(True, 500000))
                    assert packet[2]
                    actual = decode(packet[0])
                    assert actual.shape == pixels.shape
                    frame = av.VideoFrame.from_ndarray(expected, format="bgr24")
                    frame.pts = 0
                    frame.time_base = fractions.Fraction(1, 90000)
                    encoded, _ = Vp8Encoder().encode(frame, True)
                    baseline = decode(
                        b"".join(VpxPayloadDescriptor.parse(p)[1] for p in encoded)
                    )
                    score, control = psnr(expected, actual), psnr(expected, baseline)
                    assert score > 30 and score >= control - 3, (score, control)
                    assert source.processing["encoded"] == 1
                    # Force another keyframe after bitrate update; a fresh decoder
                    # must decode it without having any earlier inter frames.
                    time.sleep(0.08)
                    changed = source.next_packet(True, 300000)
                    assert changed and changed[2]
                    decode(changed[0])
                    if compressed:
                        publisher.publish(CompressedImage(format="jpeg", data=b"bad"))
                        time.sleep(0.08)
                        source.next_packet(False, 300000)
                        assert source.processing["conversion_errors"] >= 1
                        publisher.publish(msg)
                        time.sleep(0.08)
                        assert source.next_packet(True, 300000)
                    results.append(
                        {
                            "compressed": compressed,
                            "cycle": cycle,
                            "psnr_native": round(score, 2),
                            "psnr_python": round(control, 2),
                            "stats": source.processing,
                        }
                    )
                    source.stop()
                    wait_for(lambda p=publisher: p.get_subscription_count() == 0)
                    source.stop()
            finally:
                source.stop()
                node.destroy_publisher(publisher)
    finally:
        node.destroy_node()
        rclpy.shutdown()
    print(results, flush=True)


async def verify_rtcp():
    class Source:
        frames = LatestFrame()

    manager = SharedPacketPeerManager(Source(), max_fps=15)
    pc = RTCPeerConnection()
    track = manager._make_media_track()
    sender = pc.addTrack(track)
    manager._configure_sender(sender)
    manager.hub.clients[track] = 500000
    manager.hub.keyframe = False
    try:
        await sender._handle_rtcp_packet(
            RtcpPsfbPacket(fmt=RTCP_PSFB_PLI, ssrc=1, media_ssrc=sender._ssrc)
        )
        assert manager.hub.keyframe
        await sender._handle_rtcp_packet(
            RtcpPsfbPacket(
                fmt=RTCP_PSFB_APP,
                ssrc=1,
                media_ssrc=0,
                fci=pack_remb_fci(300000, [sender._ssrc]),
            )
        )
        assert manager.hub.clients[track] == 300000
    finally:
        await pc.close()
        await manager.close()
    print("RTCP PLI and REMB forwarding passed", flush=True)


if __name__ == "__main__":
    verify_media()
    asyncio.run(verify_rtcp())
