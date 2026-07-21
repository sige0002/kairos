"""CompressedImage (dora Arrow struct form) -> BGR ``numpy`` array, + downscale.

The bridge delivers each ``sensor_msgs/CompressedImage`` as a pyarrow struct;
:func:`dora_live.nodes.probe.decode_first` turns it into a dict
``{header, format, data}``. ``data`` is a JPEG/PNG byte buffer — ``bytes`` on
most Arrow builds, ``list[int]`` on some — so it is normalised to ``bytes``
before OpenCV decodes it to BGR (exactly what the aiortc track encodes).

``cv2`` / ``numpy`` are imported lazily so the pure-logic tests import this
module without them; :func:`downscale_bgr` is a no-op (and imports nothing) when
no size cap is set.
"""

from __future__ import annotations

from typing import Any


def compressed_dict_to_bgr(decoded: dict[str, Any]) -> Any:
    """Decode a bridged ``CompressedImage`` dict to a BGR ``numpy`` array.

    ``decoded`` is the first row of the Arrow struct (from ``decode_first``):
    ``{"header": ..., "format": "jpeg"|"png"|..., "data": bytes|list[int]}``.
    OpenCV decodes the JPEG/PNG buffer directly to BGR.
    """
    import cv2
    import numpy as np

    data = decoded.get("data")
    if data is None:
        raise ValueError("CompressedImage payload missing 'data'")
    if not isinstance(data, (bytes, bytearray, memoryview)):
        # Arrow may hand back the byte buffer as a list[int]; normalise it.
        data = bytes(data)
    buf = np.frombuffer(bytes(data), dtype=np.uint8)
    frame = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    if frame is None:
        raise ValueError("cv2.imdecode returned no image for CompressedImage")
    return frame


def downscale_bgr(frame: Any, max_width: int | None, max_height: int | None) -> Any:
    """Downscale *frame* to fit ``max_width`` x ``max_height``, aspect-preserved.

    Only ever shrinks (preview never upscales). Returns *frame* unchanged — and
    imports nothing — when no cap is set or it already fits.
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
