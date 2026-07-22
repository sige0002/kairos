"""In-node WebRTC lane: decode bridged CompressedImage frames + serve signaling.

Architecture (a): the whole WebRTC media path lives inside this dora node
process. The node taps every bridged ``CompressedImage`` topic (fan-in),
decodes the freshest frame per topic, and feeds a
:class:`~dora_live.webrtc_frame.FrameRouter`; a uvicorn server on a
SAME-PROCESS thread serves the ``webrtc_streamer``-compatible signaling API
(``/stream/start|stop|status|offer``) on ``DORA_LIVE_WEBRTC_PORT`` (default
8007), and the aiortc tracks read the latest frame from the router. Media never
crosses the control sidecar — it is closed inside this node. The frontend
switches backends purely by env (nginx ``WEBRTC_HOST``/``WEBRTC_PORT``), no code
change.

Only topics with an active stream are decoded (no client watching a camera =
no JPEG decode). Reuses ``decode_first`` (probe node) and ``classify_value``
(bridge_logic) to guard unbridged / non-struct values; a single bad frame is
logged once per topic and never kills the node.
"""

from __future__ import annotations

import os
import sys

from dora_live.bridge_logic import classify_value
from dora_live.nodes.probe import decode_first
from dora_live.webrtc_frame import FrameRouter

DEFAULT_WEBRTC_PORT = 8007


def log(*parts: object) -> None:
    print("[webrtc]", *parts, file=sys.stderr, flush=True)


def main() -> int:
    import threading

    import uvicorn
    from dora import Node
    from kairos_common import get_settings

    from dora_live.webrtc_app import create_webrtc_app
    from dora_live.webrtc_convert import compressed_dict_to_bgr

    port = int(os.environ.get("DORA_LIVE_WEBRTC_PORT", str(DEFAULT_WEBRTC_PORT)))
    settings = get_settings()
    router = FrameRouter()
    # Bus topic set (from the dataflow generator): /stream/start for anything
    # else is rejected honestly instead of streaming the black fallback.
    bus_topics = {
        t for t in os.environ.get("DORA_LIVE_WEBRTC_TOPICS", "").split(",") if t
    }
    app = create_webrtc_app(router, bus_topics=bus_topics)

    # Signaling HTTP runs on its own thread in this process (media is fed from
    # the dora event loop below into the shared, thread-safe router).
    server = uvicorn.Server(
        uvicorn.Config(app, host=settings.bind_host, port=port, log_level="warning")
    )
    thread = threading.Thread(target=server.run, name="dora-live-webrtc", daemon=True)
    thread.start()

    node = Node()
    decode_warned: set[str] = set()
    log("up; signaling on", port)
    try:
        while True:
            ev = node.next(timeout=1.0)
            if ev is None:
                continue
            if ev["kind"] != "dora":
                continue
            if ev["type"] == "STOP":
                log("STOP")
                break
            if ev["type"] != "INPUT":
                continue

            meta = ev.get("metadata") or {}
            topic = meta.get("topic")
            # Gate on wants(): decode only topics a client is actually watching.
            if not topic or not router.wants(topic):
                continue
            info = classify_value(ev["value"])
            if not info.bridged:
                continue
            decoded = decode_first(ev["value"])
            if decoded is None:
                continue
            try:
                bgr = compressed_dict_to_bgr(decoded)
            except Exception as exc:  # noqa: BLE001 - a bad frame must not kill the node
                if topic not in decode_warned:
                    decode_warned.add(topic)
                    log("decode failed for", topic, "->", exc)
                continue
            router.feed(topic, bgr)
    finally:
        server.should_exit = True
    return 0


if __name__ == "__main__":
    sys.exit(main())
