"""ROS image message -> BGR ``numpy`` array conversions (OpenCV).

These helpers turn ``sensor_msgs/Image`` and ``sensor_msgs/CompressedImage``
into the BGR ``numpy`` arrays the media track encodes. They live apart from the
source so the conversion logic is its own unit (and so :mod:`source` imports
without numpy/OpenCV present).

This is a preview path: only the common encodings are handled, and unusual ones
are converted best-effort. ``cv2`` and ``numpy`` are imported lazily — the unit
tests for the registry and frame queue never call these, so the bare test
environment needs neither.
"""

from __future__ import annotations

from typing import Any


def compressed_image_to_bgr(msg: Any) -> Any:
    """Decode a ``sensor_msgs/CompressedImage`` to a BGR ``numpy`` array.

    The ``data`` field is a JPEG/PNG byte buffer; OpenCV decodes it directly to
    BGR, which is exactly what the encoder wants.
    """
    import cv2
    import numpy as np

    buf = np.frombuffer(bytes(msg.data), dtype=np.uint8)
    frame = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    if frame is None:
        raise ValueError("cv2.imdecode returned no image for CompressedImage")
    return frame


def image_to_bgr(msg: Any) -> Any:
    """Convert a raw ``sensor_msgs/Image`` to a BGR ``numpy`` array.

    Handles the encodings a camera preview commonly sees (``bgr8``/``rgb8``,
    ``mono8``/``mono16``, and ``bayer_*``). The raw bytes are reshaped to
    ``(height, width, channels)`` and colour-converted to BGR. Unknown
    multi-channel encodings are passed through as-is (best-effort preview).
    """
    import cv2
    import numpy as np

    encoding = (msg.encoding or "").lower()
    height, width = int(msg.height), int(msg.width)
    raw = np.frombuffer(bytes(msg.data), dtype=_dtype_for(encoding))

    if encoding in ("mono8", "mono16", "8uc1", "16uc1"):
        gray = raw.reshape(height, width)
        return cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
    if encoding.startswith("bayer"):
        bayer = raw.reshape(height, width)
        code = _BAYER_CODES.get(encoding)
        if code is not None:
            return cv2.cvtColor(bayer, code)
        return cv2.cvtColor(bayer, cv2.COLOR_BayerBG2BGR)

    channels = max(1, raw.size // (height * width)) if height and width else 1
    frame = raw.reshape(height, width, channels)
    if encoding == "rgb8":
        return cv2.cvtColor(frame, cv2.COLOR_RGB2BGR)
    if encoding == "rgba8":
        return cv2.cvtColor(frame, cv2.COLOR_RGBA2BGR)
    if encoding == "bgra8":
        return cv2.cvtColor(frame, cv2.COLOR_BGRA2BGR)
    # bgr8 (and anything else 3-channel): already BGR for the encoder.
    return frame


def downscale_bgr(frame: Any, max_width: int | None, max_height: int | None) -> Any:
    """Downscale *frame* to fit ``max_width`` x ``max_height``, aspect-preserved.

    Only ever shrinks (preview never upscales). Returns *frame* unchanged when
    no cap is set or it already fits.
    """
    if max_width is None and max_height is None:
        return frame
    import cv2

    height, width = frame.shape[0], frame.shape[1]
    scale = 1.0
    if max_width is not None and width > max_width:
        scale = min(scale, max_width / width)
    if max_height is not None and height > max_height:
        scale = min(scale, max_height / height)
    if scale >= 1.0:
        return frame
    new_size = (max(1, int(width * scale)), max(1, int(height * scale)))
    return cv2.resize(frame, new_size, interpolation=cv2.INTER_AREA)


def _dtype_for(encoding: str) -> Any:
    """Return the numpy dtype backing a ROS image *encoding*."""
    import numpy as np

    if encoding in ("mono16", "16uc1", "bayer_rggb16", "bayer_bggr16"):
        return np.uint16
    return np.uint8


# Map the four ROS bayer encodings to their OpenCV debayer codes. ROS names the
# pattern by the top-left 2x2 layout; OpenCV's COLOR_Bayer<XX>2BGR uses the
# second-row-second-column convention, which inverts the pair — hence the
# swapped-looking mapping below.
def _bayer_codes() -> dict[str, int]:
    import cv2

    return {
        "bayer_rggb8": cv2.COLOR_BayerBG2BGR,
        "bayer_bggr8": cv2.COLOR_BayerRG2BGR,
        "bayer_gbrg8": cv2.COLOR_BayerGR2BGR,
        "bayer_grbg8": cv2.COLOR_BayerGB2BGR,
    }


class _LazyBayerCodes:
    """Lazily-populated bayer code map (OpenCV imported on first access)."""

    _cache: dict[str, int] | None = None

    def get(self, key: str) -> int | None:
        if self._cache is None:
            self._cache = _bayer_codes()
        return self._cache.get(key)


_BAYER_CODES = _LazyBayerCodes()
