"""Video-lane decoders: routing, raw Image, and the stateful ffmpeg path."""

import numpy as np
import pytest
from dora_live.video_decode import (
    CompressedImageDecoder,
    FfmpegPacketDecoder,
    RawImageDecoder,
    ffmpeg_decoder_name,
    make_decoder,
)


def test_make_decoder_routes_codecs():
    assert isinstance(make_decoder("image"), CompressedImageDecoder)
    assert isinstance(make_decoder("ffmpeg"), FfmpegPacketDecoder)
    assert isinstance(make_decoder("raw"), RawImageDecoder)
    with pytest.raises(ValueError, match="unknown video codec"):
        make_decoder("mp3")


def test_load_video_map_tolerates_garbage():
    from dora_live.nodes.webrtc import load_video_map

    assert load_video_map(None) == {}
    assert load_video_map("") == {}
    assert load_video_map("not json") == {}
    assert load_video_map('{"/cam": "ffmpeg"}') == {"/cam": "ffmpeg"}


def test_ffmpeg_decoder_name_mapping():
    assert ffmpeg_decoder_name("libx264") == "h264"
    assert ffmpeg_decoder_name("h264_nvenc") == "h264"
    assert ffmpeg_decoder_name("hevc_vaapi") == "hevc"
    assert ffmpeg_decoder_name("libx265") == "hevc"
    assert ffmpeg_decoder_name("mjpeg") == "mjpeg"
    assert ffmpeg_decoder_name("weird") == "weird"


# ---- raw sensor_msgs/Image --------------------------------------------------


def test_raw_bgr8_reshapes():
    frame = np.arange(4 * 4 * 3, dtype=np.uint8).reshape(4, 4, 3)
    out = RawImageDecoder().decode(
        {"data": frame.tobytes(), "height": 4, "width": 4, "encoding": "bgr8"}
    )
    assert out.shape == (4, 4, 3)
    assert (out == frame).all()


def test_raw_rgb8_converts_channel_order():
    rgb = np.zeros((2, 2, 3), dtype=np.uint8)
    rgb[..., 0] = 255  # pure red in RGB
    out = RawImageDecoder().decode(
        {"data": rgb.tobytes(), "height": 2, "width": 2, "encoding": "rgb8"}
    )
    assert out[0, 0].tolist() == [0, 0, 255]  # red lands in the BGR R channel


def test_raw_mono8_expands_to_bgr():
    mono = np.full((2, 3), 7, dtype=np.uint8)
    out = RawImageDecoder().decode(
        {"data": mono.tobytes(), "height": 2, "width": 3, "encoding": "mono8"}
    )
    assert out.shape == (2, 3, 3) and (out == 7).all()


def test_raw_respects_row_step_padding():
    # 2x2 bgr8 with step=8 (2 padding bytes per row).
    rows = np.zeros((2, 8), dtype=np.uint8)
    rows[:, :6] = 9
    out = RawImageDecoder().decode(
        {"data": rows.tobytes(), "height": 2, "width": 2, "encoding": "bgr8", "step": 8}
    )
    assert out.shape == (2, 2, 3) and (out == 9).all()


def test_raw_unsupported_encoding_raises():
    with pytest.raises(ValueError, match="unsupported raw Image encoding"):
        RawImageDecoder().decode(
            {"data": b"\x00" * 8, "height": 2, "width": 2, "encoding": "16UC1"}
        )


def test_raw_short_payload_raises():
    with pytest.raises(ValueError, match="too small"):
        RawImageDecoder().decode(
            {"data": b"\x00" * 3, "height": 2, "width": 2, "encoding": "bgr8"}
        )


# ---- stateful ffmpeg (H.264) ------------------------------------------------


def _h264_packets(n_frames: int = 12, size: int = 64):
    """Encode solid frames to H.264 AUs: [(bytes, is_keyframe), ...]."""
    av = pytest.importorskip("av")
    try:
        enc = av.CodecContext.create("libx264", "w")
    except Exception:  # pragma: no cover - wheel without x264
        pytest.skip("libx264 encoder unavailable in this av build")
    enc.width = size
    enc.height = size
    enc.pix_fmt = "yuv420p"
    enc.framerate = 10
    enc.options = {"tune": "zerolatency"}  # no B-frame lookahead buffering
    packets = []
    for i in range(n_frames):
        img = np.full((size, size, 3), (i * 20) % 255, dtype=np.uint8)
        frame = av.VideoFrame.from_ndarray(img, format="bgr24").reformat(
            format="yuv420p"
        )
        for pkt in enc.encode(frame):
            packets.append((bytes(pkt), bool(pkt.is_keyframe)))
    for pkt in enc.encode(None):
        packets.append((bytes(pkt), bool(pkt.is_keyframe)))
    return packets


def test_ffmpeg_decodes_h264_stream():
    packets = _h264_packets()
    dec = FfmpegPacketDecoder()
    frames = [
        dec.decode({"data": data, "encoding": "libx264", "flags": 1 if key else 0})
        for data, key in packets
    ]
    got = [f for f in frames if f is not None]
    assert got, "no frame decoded from the H.264 stream"
    assert got[0].shape == (64, 64, 3)


def test_ffmpeg_waits_for_keyframe():
    packets = _h264_packets()
    delta = next((data for data, key in packets if not key), None)
    if delta is None:
        pytest.skip("encoder produced only keyframes")
    dec = FfmpegPacketDecoder()
    # A delta frame before any keyframe must be refused, not smeared.
    assert dec.decode({"data": delta, "encoding": "libx264", "flags": 0}) is None


def test_ffmpeg_resets_after_feed_gap():
    dec = FfmpegPacketDecoder(reset_gap_s=0.5)
    packets = _h264_packets()
    data, key = packets[0]
    assert key, "first H.264 packet should be a keyframe"
    dec.decode({"data": data, "encoding": "libx264", "flags": 1})
    assert dec._ctx is not None
    # Simulate an idle gap (nobody watched the topic for a while).
    dec._last_feed -= 10.0
    delta = next((d for d, k in packets if not k), None)
    if delta is None:
        pytest.skip("encoder produced only keyframes")
    assert dec.decode({"data": delta, "encoding": "libx264", "flags": 0}) is None
    assert dec._seen_keyframe is False  # state dropped, waiting for a keyframe
