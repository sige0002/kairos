"""LatestFrame + FrameRouter + RouterFrameSource (no aiortc / OpenCV).

Frames are opaque sentinels and no downscale cap is set, so the router fan-out
and rate accounting are exercised without numpy/cv2.
"""

from __future__ import annotations

from dora_live.webrtc_frame import FrameRouter, LatestFrame, RouterFrameSource


def test_latest_frame_wins_and_close() -> None:
    buf: LatestFrame[str] = LatestFrame()
    buf.put("a")
    buf.put("b")  # overwrites the un-taken frame (the accepted drop)
    assert buf.latest_nowait() == "b"
    buf.close()
    assert buf.closed
    assert buf.latest_nowait() is None
    buf.put("c")  # no-op after close
    assert buf.latest_nowait() is None


def test_router_fans_out_and_gates_on_wants() -> None:
    router = FrameRouter()
    assert router.wants("/cam") is False
    router.feed("/cam", "dropped-no-sink")  # no sink: silently ignored

    a: LatestFrame[str] = LatestFrame()
    b: LatestFrame[str] = LatestFrame()
    router.attach("/cam", a)
    router.attach("/cam", b)
    assert router.wants("/cam") is True

    router.feed("/cam", "f1")
    assert a.latest_nowait() == "f1"
    assert b.latest_nowait() == "f1"

    router.detach("/cam", a)
    assert router.wants("/cam") is True  # b still attached
    router.detach("/cam", b)
    assert router.wants("/cam") is False
    assert router.rate("/cam") == 0.0  # meter dropped with the last sink


def test_router_rate_reflects_feed() -> None:
    router = FrameRouter()
    buf: LatestFrame[str] = LatestFrame()
    router.attach("/cam", buf)
    for _ in range(5):
        router.feed("/cam", "f")
    assert router.rate("/cam") > 0.0
    assert router.rate("/other") == 0.0


def test_router_frame_source_lifecycle() -> None:
    router = FrameRouter()
    src = RouterFrameSource(router, "/cam")
    assert router.wants("/cam") is False  # not attached until start()
    src.start()
    assert router.wants("/cam") is True

    router.feed("/cam", "frame")
    assert src.frames.latest_nowait() == "frame"

    src.start()  # idempotent
    assert router.wants("/cam") is True

    src.stop()
    assert router.wants("/cam") is False
    assert src.frames.closed
    assert src.fps == 0.0


def test_decode_fps_tracks_fastest_sink():
    from dora_live.webrtc_frame import FrameRouter, LatestFrame

    router = FrameRouter()
    assert router.decode_fps("/cam") == 0.0  # nobody watching
    slow, fast = LatestFrame(), LatestFrame()
    router.attach("/cam", slow, max_fps=10)
    assert router.decode_fps("/cam") == 10.0
    router.attach("/cam", fast, max_fps=30)
    assert router.decode_fps("/cam") == 30.0  # fastest client wins
    router.detach("/cam", fast)
    assert router.decode_fps("/cam") == 10.0
    router.detach("/cam", slow)
    assert router.decode_fps("/cam") == 0.0


def test_source_start_registers_its_fps():
    from dora_live.webrtc_frame import FrameRouter, RouterFrameSource

    router = FrameRouter()
    src = RouterFrameSource(router, "/cam", max_fps=25)
    src.start()
    assert router.decode_fps("/cam") == 25.0
    src.stop()
    assert router.decode_fps("/cam") == 0.0
