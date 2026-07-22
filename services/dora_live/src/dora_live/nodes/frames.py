"""Frames dataflow node: decimated compressed payloads -> the control store.

Taps the video-lane topics whose codec the lane forwards (``image`` as-is,
``ffmpeg`` keyframes only — see :mod:`dora_live.frames_lane`), rate-caps each
topic to ``FRAMES_SAMPLE_HZ``, and POSTs the payload to the control sidecar
(``POST /internal/frames``, base64 body). Never decodes, never re-encodes,
never blocks the bus: a failed POST is dropped (lossy-tolerant, same policy
as the other feeds) — consumers poll ``GET /live/frames`` for whatever is
freshest.

Env: DORA_LIVE_FRAMES_MAP (JSON topic->codec), FRAMES_SAMPLE_HZ, CONTROL_URL.
"""

from __future__ import annotations

import base64
import json
import os
import sys

from dora_live.bridge_logic import classify_value
from dora_live.frames_lane import SampleGate, frame_eligible
from dora_live.nodes.probe import decode_first

DEFAULT_SAMPLE_HZ = 2.0


def log(*parts: object) -> None:
    print("[frames]", *parts, file=sys.stderr, flush=True)


def payload_bytes(decoded: dict) -> bytes | None:
    """The compressed byte buffer of a CompressedImage/FFMPEGPacket dict."""
    data = decoded.get("data")
    if data is None:
        return None
    if isinstance(data, (bytes, bytearray, memoryview)):
        return bytes(data)
    return bytes(data)  # arrow may deliver list[int]


def extract_flags(value: object) -> int | None:
    """Cheap ``flags`` read via Arrow column access (no full ``to_pylist``).

    The keyframe gate must run on EVERY ffmpeg message, so it cannot afford
    the whole-struct conversion ``decode_first`` does.
    """
    try:
        typ = value.type  # type: ignore[attr-defined]
        names = [typ.field(i).name for i in range(typ.num_fields)]
        if "flags" not in names:
            return None
        return int(value.field("flags")[0].as_py())  # type: ignore[attr-defined]
    except Exception:
        return None


def main() -> int:
    import httpx
    from dora import Node

    control_url = os.environ.get("CONTROL_URL", "http://127.0.0.1:9601").rstrip("/")
    endpoint = f"{control_url}/internal/frames"
    codec_map: dict[str, str] = json.loads(
        os.environ.get("DORA_LIVE_FRAMES_MAP") or "{}"
    )
    gate = SampleGate(float(os.environ.get("FRAMES_SAMPLE_HZ", DEFAULT_SAMPLE_HZ)))
    client = httpx.Client(timeout=2.0)

    node = Node()
    log("up; topics:", codec_map or "(none)")
    while True:
        ev = node.next(timeout=1.0)
        if ev is None:
            continue
        if ev["kind"] != "dora":
            continue
        if ev["type"] == "STOP":
            log("STOP")
            break
        if ev["type"] != "INPUT" or ev["id"] == "tick":
            continue

        meta = ev.get("metadata") or {}
        topic = meta.get("topic")
        codec = codec_map.get(topic or "")
        if not topic or codec is None:
            continue
        info = classify_value(ev["value"])
        if not info.bridged:
            continue
        # Cheap gates BEFORE the whole-struct Arrow->Python conversion: at
        # camera rates the conversion costs ~ms per frame, and gating after
        # it burned ~45% of a core on two ~30 Hz cameras (measured). The
        # keyframe gate still precedes the rate gate so a refused delta
        # frame never burns a rate slot.
        if codec == "ffmpeg" and not frame_eligible(codec, extract_flags(ev["value"])):
            continue
        if not gate.allow(topic):
            continue
        decoded = decode_first(ev["value"])
        if decoded is None:
            continue
        data = payload_bytes(decoded)
        if not data:
            continue
        stamp_ns = meta.get("stamp_ns")
        body = {
            "topic": topic,
            "codec": codec,
            "encoding": str(decoded.get("format") or decoded.get("encoding") or ""),
            "stamp_ns": int(stamp_ns) if stamp_ns else None,
            "recv_t": int(meta.get("t_recv_ns", "0")) / 1e9,
            "data_b64": base64.b64encode(data).decode("ascii"),
        }
        try:
            client.post(endpoint, json=body)
        except Exception:
            pass  # lossy-tolerant: the store simply keeps its previous frame
    return 0


if __name__ == "__main__":
    sys.exit(main())
