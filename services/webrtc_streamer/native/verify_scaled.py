"""Compare packaged scaled decoding against a baseline library using real ROS."""

import json
import os
import struct
import time

import cv2
import numpy as np
import rclpy
from sensor_msgs.msg import CompressedImage
from verify_native import decode, psnr, wait_for
from webrtc_streamer.native_source import NativeImageSource


def run():
    rclpy.init()
    node = rclpy.create_node("scaled_preview_test")
    publisher = node.create_publisher(CompressedImage, "/test/scaled", 1)
    results = []
    try:
        for width, height, cap_w, cap_h, kind in (
            (640, 480, 640, 480, "jpeg"),
            (640, 480, 320, 240, "jpeg"),
            (1920, 1080, 426, 240, "jpeg"),
            (2560, 1440, 320, 180, "jpeg"),
            (641, 481, 320, 240, "jpeg"),
            (640, 480, 320, 240, "progressive"),
            (640, 480, 320, 240, "png"),
            (640, 480, 320, 240, "exif"),
        ):
            yy, xx = np.mgrid[:height, :width]
            pixels = np.stack((xx % 256, yy % 256, (xx + yy) % 256), axis=-1).astype(
                np.uint8
            )
            if kind == "exif":
                _, encoded = cv2.imencode(".jpg", pixels)
                # Minimal little-endian TIFF IFD: orientation=6 (90 degrees).
                exif = (
                    b"Exif\0\0II"
                    + struct.pack("<HIH", 42, 8, 1)
                    + struct.pack("<HHI", 274, 3, 1)
                    + struct.pack("<H", 6)
                    + b"\0\0"
                    + struct.pack("<I", 0)
                )
                data = encoded.tobytes()
                data = (
                    data[:2]
                    + b"\xff\xe1"
                    + struct.pack(">H", len(exif) + 2)
                    + exif
                    + data[2:]
                )
            else:
                _, encoded = cv2.imencode(
                    ".png" if kind == "png" else ".jpg",
                    pixels,
                    [cv2.IMWRITE_JPEG_PROGRESSIVE, int(kind == "progressive")],
                )
                data = encoded.tobytes()
            msg = CompressedImage(format=kind, data=data)
            images = []
            for library in (
                os.environ["BASELINE_LIBRARY"],
                "/opt/kairos/lib/libkairos_streamer_native.so",
            ):
                os.environ["KAIROS_STREAMER_NATIVE_LIBRARY"] = library
                source = NativeImageSource(
                    "/test/scaled", max_width=cap_w, max_height=cap_h
                )
                try:
                    source.start()
                    wait_for(lambda: publisher.get_subscription_count() > 0)
                    for _ in range(3):
                        publisher.publish(msg)
                        time.sleep(0.04)
                    wait_for(lambda s=source: s.processing["received"] > 0)
                    packet = wait_for(lambda s=source: s.next_packet(True, 500000))
                    images.append(decode(packet[0]))
                    assert source.processing["conversion_errors"] == 0
                    if kind == "jpeg" and cap_w == width:
                        publisher.publish(
                            CompressedImage(format="jpeg", data=b"\xff\xd8bad")
                        )
                        time.sleep(0.1)
                        source.next_packet(False, 500000)
                        assert source.processing["conversion_errors"] == 1
                        publisher.publish(msg)
                        time.sleep(0.1)
                        recovered = source.next_packet(True, 500000)
                        assert recovered and recovered[2]
                        decode(recovered[0])
                finally:
                    source.stop()
                    wait_for(lambda: publisher.get_subscription_count() == 0)
            assert images[0].shape == images[1].shape
            score = psnr(*images)
            if kind in ("png", "exif") or cap_w == width:
                assert np.array_equal(*images), (kind, score)
            else:
                assert score > 28, (kind, score)
            result = {
                "input": [width, height],
                "cap": [cap_w, cap_h],
                "kind": kind,
                "output": list(images[1].shape),
                "baseline_vs_scaled_psnr": float(score),
            }
            results.append(result)
            print(json.dumps(result), flush=True)
        print(
            "scaled JPEG dimensions, fidelity, progressive, PNG and EXIF checks passed"
        )
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    run()
