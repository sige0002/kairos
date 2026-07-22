"""In-node WebRTC lane: decode bridged camera frames + serve signaling.

Architecture (a): the whole WebRTC media path lives inside this dora node
process. The node taps every video-lane topic (fan-in; the generator selects
them and ships their topic->codec map as ``DORA_LIVE_VIDEO_MAP``), decodes the
freshest frame per topic through a per-topic decoder
(:mod:`dora_live.video_decode` — CompressedImage via cv2, FFMPEGPacket via
PyAV/ffmpeg, raw Image opt-in), and feeds a
:class:`~dora_live.webrtc_frame.FrameRouter`; a uvicorn server on a
SAME-PROCESS thread serves the ``webrtc_streamer``-compatible signaling API
(``/stream/start|stop|status|offer``) on ``DORA_LIVE_WEBRTC_PORT`` (default
8007), and the aiortc tracks read the latest frame from the router. Media never
crosses the control sidecar — it is closed inside this node. The frontend
switches backends purely by env (nginx ``WEBRTC_HOST``/``WEBRTC_PORT``), no code
change.

Only topics with an active stream are decoded (no client watching a camera =
no decode). For the stateful ffmpeg codec that also means join-at-keyframe on
attach: the first frame can lag by up to one GOP. Reuses ``decode_first``
(probe node) and ``classify_value`` (bridge_logic) to guard unbridged /
non-struct values; a single bad frame is logged once per topic and never kills
the node.
"""

from __future__ import annotations

import json
import os
import sys
import time

from dora_live.bridge_logic import classify_value
from dora_live.nodes.probe import decode_first
from dora_live.video_decode import VideoDecoder, make_decoder
from dora_live.webrtc_frame import FrameRouter

DEFAULT_WEBRTC_PORT = 8007


def log(*parts: object) -> None:
    print("[webrtc]", *parts, file=sys.stderr, flush=True)


def load_video_map(raw: str | None) -> dict[str, str]:
    """Parse ``DORA_LIVE_VIDEO_MAP`` (JSON topic->codec); tolerate absence."""
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except ValueError as exc:
        log("bad DORA_LIVE_VIDEO_MAP (ignoring):", exc)
        return {}
    if not isinstance(parsed, dict):
        return {}
    return {str(k): str(v) for k, v in parsed.items()}


def main() -> int:
    import threading

    import uvicorn
    from dora import Node
    from kairos_common import get_settings

    from dora_live.webrtc_app import create_webrtc_app
    from dora_live.webrtc_models import VideoDefaults

    port = int(os.environ.get("DORA_LIVE_WEBRTC_PORT", str(DEFAULT_WEBRTC_PORT)))
    settings = get_settings()
    router = FrameRouter()
    # Bus topic->codec map (from the dataflow generator): /stream/start for
    # anything else is rejected honestly instead of streaming silent black.
    video_map = load_video_map(os.environ.get("DORA_LIVE_VIDEO_MAP"))
    try:
        defaults = VideoDefaults.model_validate(
            json.loads(os.environ.get("DORA_LIVE_VIDEO_DEFAULTS") or "{}")
        )
    except Exception as exc:  # noqa: BLE001 - bad env must not kill the lane
        log("bad DORA_LIVE_VIDEO_DEFAULTS (using built-ins):", exc)
        defaults = VideoDefaults()
    app = create_webrtc_app(router, bus_topics=set(video_map), video_defaults=defaults)

    # Signaling HTTP runs on its own thread in this process (media is fed from
    # the dora event loop below into the shared, thread-safe router).
    server = uvicorn.Server(
        uvicorn.Config(app, host=settings.bind_host, port=port, log_level="warning")
    )
    thread = threading.Thread(target=server.run, name="dora-live-webrtc", daemon=True)
    thread.start()
    # Fail LOUDLY when signaling cannot bind (port still held by an orphaned
    # predecessor, the legacy streamer, ...): uvicorn's failure kills only its
    # thread, which would leave a healthy-looking node with dead signaling —
    # "camera silently gone". Exiting nonzero routes the fault into the
    # supervisor's crash-loop guard instead (degraded + readyz 503 = visible).
    deadline = time.monotonic() + 10.0
    while time.monotonic() < deadline and thread.is_alive() and not server.started:
        time.sleep(0.1)
    if not server.started:
        log("signaling failed to start on port", port, "- exiting for restart")
        return 1

    node = Node()
    decoders: dict[str, VideoDecoder] = {}
    decode_warned: set[str] = set()
    last_decode: dict[str, float] = {}
    log("up; signaling on", port, "video:", video_map or "(none)")
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
            # Rate gate for STATELESS codecs: the tracks pace their output to
            # max_fps, so decoding a 30 Hz camera to show 15 fps burns half
            # the decode CPU on frames that are overwritten unseen (field
            # incident: choppy preview at ~150% CPU). ffmpeg (inter-frame)
            # is exempt — delta frames need every predecessor to stay
            # coherent, so it must decode at full rate while watched.
            codec = video_map.get(topic, "image")
            if codec != "ffmpeg":
                now = time.monotonic()
                fps = router.decode_fps(topic)
                # 10% slack: discrete ~30 Hz arrivals against a strict 1/fps
                # interval would alias the effective rate visibly below fps.
                if fps > 0 and now - last_decode.get(topic, 0.0) < 0.9 / fps:
                    continue
                last_decode[topic] = now
            info = classify_value(ev["value"])
            if not info.bridged:
                continue
            decoded = decode_first(ev["value"])
            if decoded is None:
                continue
            try:
                decoder = decoders.get(topic)
                if decoder is None:
                    decoder = decoders[topic] = make_decoder(codec)
                bgr = decoder.decode(decoded)
            except Exception as exc:  # noqa: BLE001 - a bad frame must not kill the node
                if topic not in decode_warned:
                    decode_warned.add(topic)
                    log("decode failed for", topic, "->", exc)
                continue
            if bgr is None:
                continue  # stateful codec still syncing (keyframe wait) etc.
            router.feed(topic, bgr)
    finally:
        server.should_exit = True
    return 0


if __name__ == "__main__":
    sys.exit(main())
