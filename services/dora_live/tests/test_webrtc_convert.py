"""CompressedImage (dict form) -> BGR decode + downscale (needs cv2/numpy)."""

from __future__ import annotations

import pytest

np = pytest.importorskip("numpy")
cv2 = pytest.importorskip("cv2")

from dora_live.webrtc_convert import (  # noqa: E402
    compressed_dict_to_bgr,
    downscale_bgr,
)


def _jpeg_bytes(width: int = 64, height: int = 48) -> bytes:
    img = np.zeros((height, width, 3), dtype=np.uint8)
    img[:, : width // 2] = (0, 0, 255)  # BGR red half
    ok, buf = cv2.imencode(".jpg", img)
    assert ok
    return buf.tobytes()


def test_decode_bytes_payload() -> None:
    decoded = {"format": "jpeg", "data": _jpeg_bytes()}
    frame = compressed_dict_to_bgr(decoded)
    assert frame.shape == (48, 64, 3)


def test_decode_list_int_payload() -> None:
    # Some Arrow builds hand back the buffer as list[int]; it must still decode.
    decoded = {"format": "jpeg", "data": list(_jpeg_bytes())}
    frame = compressed_dict_to_bgr(decoded)
    assert frame.shape == (48, 64, 3)


def test_missing_data_raises() -> None:
    with pytest.raises(ValueError, match="missing 'data'"):
        compressed_dict_to_bgr({"format": "jpeg"})


def test_undecodable_payload_raises() -> None:
    with pytest.raises(ValueError, match="imdecode"):
        compressed_dict_to_bgr({"format": "jpeg", "data": b"not-a-jpeg"})


def test_downscale_shrinks_and_preserves_aspect() -> None:
    frame = np.zeros((100, 200, 3), dtype=np.uint8)
    out = downscale_bgr(frame, max_width=100, max_height=None)
    assert out.shape == (50, 100, 3)


def test_downscale_no_cap_is_identity() -> None:
    frame = np.zeros((10, 10, 3), dtype=np.uint8)
    assert downscale_bgr(frame, None, None) is frame
