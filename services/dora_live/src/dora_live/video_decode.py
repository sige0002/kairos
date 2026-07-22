"""Per-topic video decoders for the WebRTC lane (codec -> BGR frames).

One decoder instance per topic (created from the manifest's resolved codec,
``DORA_LIVE_VIDEO_MAP``), all returning a BGR ``numpy`` array or ``None``:

- ``image``  — ``sensor_msgs/CompressedImage`` (JPEG/PNG via cv2; stateless).
- ``ffmpeg`` — ``ffmpeg_image_transport(_msgs)/FFMPEGPacket`` (H.264/HEVC/...)
  via PyAV. STATEFUL: an inter-frame codec needs decode continuity, so the
  decoder keeps an ``av.CodecContext`` per topic, waits for a keyframe after
  (re)start, and resets itself when the packet feed had a gap (the node skips
  packets while no client watches — resuming mid-GOP on stale reference frames
  would smear).
- ``raw``    — ``sensor_msgs/Image`` (numpy reshape + color conversion;
  explicit config opt-in only).

Heavy imports (cv2 / numpy / av) stay inside methods so pure-logic tests can
import the module and exercise the routing without them.
"""

from __future__ import annotations

import time
from typing import Any, Protocol

from dora_live.webrtc_convert import compressed_dict_to_bgr

# Feed gap after which a stateful decoder discards codec state and re-waits
# for a keyframe: while nobody watches a topic the node does not feed packets,
# and resuming an inter-frame stream mid-GOP produces reference-frame smear.
FFMPEG_RESET_GAP_S = 1.0

_KEYFRAME_FLAG = 0x0001


class VideoDecoder(Protocol):
    """One topic's payload-dict -> BGR frame decoder."""

    def decode(self, decoded: dict[str, Any]) -> Any | None:
        """Return a BGR frame for this message, or ``None`` (not decodable yet)."""
        ...


class CompressedImageDecoder:
    """``sensor_msgs/CompressedImage`` -> BGR (stateless cv2.imdecode)."""

    def decode(self, decoded: dict[str, Any]) -> Any | None:
        return compressed_dict_to_bgr(decoded)


class RawImageDecoder:
    """``sensor_msgs/Image`` -> BGR. Supported encodings: bgr8/rgb8/mono8.

    Anything else (bayer, 16-bit depth, yuv...) returns ``None`` — the node
    logs once per topic. Kept deliberately minimal: raw is an opt-in escape
    hatch, not the recommended camera transport.
    """

    def decode(self, decoded: dict[str, Any]) -> Any | None:
        import cv2
        import numpy as np

        data = decoded.get("data")
        height = int(decoded.get("height") or 0)
        width = int(decoded.get("width") or 0)
        encoding = str(decoded.get("encoding") or "").lower()
        if data is None or height <= 0 or width <= 0:
            return None
        if not isinstance(data, (bytes, bytearray, memoryview)):
            data = bytes(data)
        buf = np.frombuffer(bytes(data), dtype=np.uint8)
        channels = {"bgr8": 3, "rgb8": 3, "mono8": 1}.get(encoding)
        if channels is None:
            raise ValueError(f"unsupported raw Image encoding: {encoding!r}")
        step = int(decoded.get("step") or width * channels)
        if buf.size < height * step:
            raise ValueError(
                f"raw Image payload too small: {buf.size} < {height}x{step}"
            )
        rows = buf[: height * step].reshape(height, step)
        frame = rows[:, : width * channels].reshape(height, width, channels)
        if encoding == "rgb8":
            return cv2.cvtColor(frame, cv2.COLOR_RGB2BGR)
        if encoding == "mono8":
            return cv2.cvtColor(frame, cv2.COLOR_GRAY2BGR)
        return frame.copy()  # bgr8: detach from the arrow-backed buffer


def ffmpeg_decoder_name(encoding: str) -> str:
    """Map an FFMPEGPacket ``encoding`` (the *encoder* name, e.g. ``libx264``,
    ``h264_nvenc``, ``hevc_vaapi``) to an ffmpeg *decoder* name."""
    e = encoding.lower()
    if "265" in e or "hevc" in e:
        return "hevc"
    if "264" in e:
        return "h264"
    if "vp9" in e:
        return "vp9"
    if "vp8" in e:
        return "vp8"
    if "av1" in e:
        return "libdav1d"
    if "jpeg" in e or "mjpeg" in e:
        return "mjpeg"
    return e  # unknown: try it as a decoder name and let PyAV complain


class FfmpegPacketDecoder:
    """``FFMPEGPacket`` -> BGR via a per-topic stateful PyAV codec context."""

    def __init__(self, *, reset_gap_s: float = FFMPEG_RESET_GAP_S) -> None:
        self._ctx: Any | None = None
        self._decoder_name: str | None = None
        self._reset_gap_s = reset_gap_s
        self._last_feed: float | None = None
        self._seen_keyframe = False
        self._clock = time.monotonic

    def _ensure_ctx(self, encoding: str) -> Any:
        import av

        name = ffmpeg_decoder_name(encoding)
        if self._ctx is None or name != self._decoder_name:
            self._ctx = av.CodecContext.create(name, "r")
            self._decoder_name = name
            self._seen_keyframe = False
        return self._ctx

    def _reset(self) -> None:
        self._ctx = None
        self._decoder_name = None
        self._seen_keyframe = False

    def decode(self, decoded: dict[str, Any]) -> Any | None:
        data = decoded.get("data")
        if data is None:
            return None
        if not isinstance(data, (bytes, bytearray, memoryview)):
            data = bytes(data)
        now = self._clock()
        if self._last_feed is not None and now - self._last_feed > self._reset_gap_s:
            self._reset()
        self._last_feed = now

        # Context first: creating (or re-creating on an encoding change) a
        # context clears the keyframe gate, so the gate must be judged after.
        ctx = self._ensure_ctx(str(decoded.get("encoding") or "h264"))

        # Keyframe gate: after a (re)start, feeding delta frames just smears.
        # flags bit 0 is AV_PKT_FLAG_KEY (ffmpeg_image_transport contract);
        # when flags are absent we optimistically try and rely on the decoder
        # erroring until it syncs.
        flags = decoded.get("flags")
        if not self._seen_keyframe and flags is not None:
            if not int(flags) & _KEYFRAME_FLAG:
                return None
            self._seen_keyframe = True
        frame = None
        try:
            for packet in ctx.parse(bytes(data)):
                for decoded_frame in ctx.decode(packet):
                    frame = decoded_frame
        except Exception:
            # Mid-stream join / corrupt packet: drop codec state and re-sync
            # from the next keyframe instead of smearing forever.
            self._reset()
            return None
        if frame is None:
            return None
        self._seen_keyframe = True
        return frame.to_ndarray(format="bgr24")


def make_decoder(codec: str) -> VideoDecoder:
    """Decoder instance for a manifest ``video`` codec (one per topic)."""
    if codec == "image":
        return CompressedImageDecoder()
    if codec == "ffmpeg":
        return FfmpegPacketDecoder()
    if codec == "raw":
        return RawImageDecoder()
    raise ValueError(f"unknown video codec: {codec!r}")
