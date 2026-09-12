# SPDX-License-Identifier: Apache-2.0
"""Compare raw preview packets against a supplied pre-change native library.

Run in the runtime image with BASELINE_LIBRARY and
KAIROS_STREAMER_NATIVE_LIBRARY pointing to the two built libraries.
"""

import hashlib
import json
import os
import time

import numpy as np
import rclpy
from sensor_msgs.msg import Image
from verify_native import decode, wait_for
from webrtc_streamer.native_source import NativeImageSource


def run() -> None:
    libraries = (
        os.environ["BASELINE_LIBRARY"],
        os.environ["KAIROS_STREAMER_NATIVE_LIBRARY"],
    )
    rclpy.init()
    node = rclpy.create_node("raw_copy_verification")
    publisher = node.create_publisher(Image, "/test/raw_copy", 10)
    cases = (
        (640, 480, 0, 0, "bgr8", 3),
        (640, 480, 320, 240, "bgr8", 3),
        (641, 481, 320, 240, "bgr8", 3),
        (1920, 1080, 320, 180, "bgr8", 3),
        (640, 480, 320, 240, "rgb8", 3),
        (640, 480, 320, 240, "mono8", 1),
        (640, 480, 320, 240, "bgra8", 4),
        (640, 480, 320, 240, "rgba8", 4),
    )
    try:
        for width, height, cap_w, cap_h, encoding, channels in cases:
            stride = width * channels + 16
            values = np.arange(stride * height, dtype=np.uint32)
            data = ((values * 37 + values // 997) % 256).astype(np.uint8)
            message = Image(
                width=width,
                height=height,
                step=stride,
                encoding=encoding,
                data=data.tobytes(),
            )
            packets = []
            for library in libraries:
                os.environ["KAIROS_STREAMER_NATIVE_LIBRARY"] = library
                source = NativeImageSource(
                    "/test/raw_copy", max_width=cap_w, max_height=cap_h
                )
                try:
                    source.start()
                    wait_for(lambda: publisher.get_subscription_count() == 1)
                    for _ in range(3):
                        publisher.publish(message)
                        time.sleep(0.04)
                    wait_for(lambda s=source: s.processing["received"] == 3)
                    packet = wait_for(lambda s=source: s.next_packet(True, 500000))
                    assert packet[2]
                    decode(packet[0])
                    assert source.processing["decoded"] == 1
                    assert source.processing["conversion_errors"] == 0
                    packets.append(packet[0])
                finally:
                    source.stop()
                    wait_for(lambda: publisher.get_subscription_count() == 0)
            assert packets[0] == packets[1], (width, height, encoding, cap_w, cap_h)
            print(
                json.dumps(
                    {
                        "input": [width, height],
                        "cap": [cap_w, cap_h],
                        "encoding": encoding,
                        "vp8_sha256": hashlib.sha256(packets[1]).hexdigest(),
                    }
                ),
                flush=True,
            )
        print("8 raw ROS/VP8 packet comparisons are byte-identical", flush=True)
    finally:
        node.destroy_node()
        rclpy.shutdown()
        os.environ["KAIROS_STREAMER_NATIVE_LIBRARY"] = libraries[1]


if __name__ == "__main__":
    run()
