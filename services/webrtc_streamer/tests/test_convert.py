"""ROS image -> BGR conversions (convert.py) over synthetic messages.

numpy + opencv-python-headless are real here, so these tests exercise the actual
reshape / colour-conversion / downscale paths the streamer uses.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pytest
from webrtc_streamer.convert import (
    compressed_image_to_bgr,
    downscale_bgr,
    image_to_bgr,
)


@dataclass
class FakeImage:
    """Minimal stand-in for sensor_msgs/Image (only the fields convert reads)."""

    encoding: str
    height: int
    width: int
    data: bytes


@dataclass
class FakeCompressed:
    """Minimal stand-in for sensor_msgs/CompressedImage."""

    format: str
    data: bytes


def test_bgr8_passes_through_unchanged() -> None:
    # A 2x2 BGR image; bgr8 is already the encoder's format.
    pixels = np.array(
        [[[1, 2, 3], [4, 5, 6]], [[7, 8, 9], [10, 11, 12]]], dtype=np.uint8
    )
    msg = FakeImage("bgr8", height=2, width=2, data=pixels.tobytes())
    out = image_to_bgr(msg)
    assert out.shape == (2, 2, 3)
    np.testing.assert_array_equal(out, pixels)


def test_rgb8_is_channel_swapped_to_bgr() -> None:
    # One red pixel in RGB (255,0,0) must become BGR (0,0,255).
    rgb = np.array([[[255, 0, 0]]], dtype=np.uint8)
    msg = FakeImage("rgb8", height=1, width=1, data=rgb.tobytes())
    out = image_to_bgr(msg)
    assert out.shape == (1, 1, 3)
    np.testing.assert_array_equal(out[0, 0], [0, 0, 255])


def test_mono8_expands_to_three_bgr_channels() -> None:
    gray = np.array([[10, 20], [30, 40]], dtype=np.uint8)
    msg = FakeImage("mono8", height=2, width=2, data=gray.tobytes())
    out = image_to_bgr(msg)
    assert out.shape == (2, 2, 3)
    # Gray->BGR replicates the value across channels.
    np.testing.assert_array_equal(out[0, 0], [10, 10, 10])
    np.testing.assert_array_equal(out[1, 1], [40, 40, 40])


def test_compressed_jpeg_round_trips() -> None:
    import cv2

    src = np.zeros((8, 8, 3), dtype=np.uint8)
    src[:, :, 2] = 255  # solid red in BGR
    ok, buf = cv2.imencode(".jpg", src)
    assert ok
    msg = FakeCompressed(format="jpeg", data=buf.tobytes())
    out = compressed_image_to_bgr(msg)
    assert out.shape == (8, 8, 3)
    # Lossy JPEG, but a solid red block stays dominantly red.
    assert out[..., 2].mean() > out[..., 0].mean()
    assert out[..., 2].mean() > out[..., 1].mean()


def test_compressed_bad_buffer_raises() -> None:
    msg = FakeCompressed(format="jpeg", data=b"not-an-image")
    with pytest.raises(ValueError):
        compressed_image_to_bgr(msg)


def test_downscale_shrinks_to_fit_and_preserves_aspect() -> None:
    frame = np.zeros((100, 200, 3), dtype=np.uint8)  # 200x100 (WxH)
    out = downscale_bgr(frame, max_width=100, max_height=None)
    # Width halved -> height halves too (aspect preserved).
    assert out.shape[1] == 100
    assert out.shape[0] == 50


def test_downscale_never_upscales() -> None:
    frame = np.zeros((50, 50, 3), dtype=np.uint8)
    out = downscale_bgr(frame, max_width=200, max_height=200)
    assert out.shape == (50, 50, 3)


def test_downscale_noop_without_caps() -> None:
    frame = np.zeros((50, 50, 3), dtype=np.uint8)
    assert downscale_bgr(frame, None, None) is frame
