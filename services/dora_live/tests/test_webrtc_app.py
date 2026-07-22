"""Signaling app contract: same shapes as webrtc_streamer, fake peer manager.

The default source factory (router-backed) is aiortc-free, so these run the full
request path (start/status/offer/stop, dedup, error shapes) natively with only
the peer manager faked.
"""

from __future__ import annotations

from dora_live.webrtc_app import create_webrtc_app
from dora_live.webrtc_frame import FrameRouter
from dora_live.webrtc_models import StreamStartRequest
from dora_live.webrtc_peer import FakePeerManager
from fastapi.testclient import TestClient


def _fake_app() -> tuple[TestClient, FrameRouter]:
    router = FrameRouter()

    def peer_factory(request: StreamStartRequest, source: object) -> FakePeerManager:
        return FakePeerManager()

    app = create_webrtc_app(router, peer_factory=peer_factory, h264_supported=False)
    return TestClient(app), router


def test_healthz_builds_without_injected_factories() -> None:
    # Default factories (router source + real aiortc peer) build and serve
    # /healthz without any stream ever starting.
    client = TestClient(create_webrtc_app(FrameRouter()))
    resp = client.get("/healthz")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_root_reports_service_and_stage() -> None:
    client, _ = _fake_app()
    body = client.get("/").json()
    assert body == {"service": "dora_live_webrtc", "stage": "live"}


def test_start_status_offer_stop_flow() -> None:
    client, _ = _fake_app()
    with client:
        started = client.post("/stream/start", json={"topic": "/cam/front"})
        assert started.status_code == 201
        sid = started.json()["stream_id"]

        status = client.get("/stream/status")
        assert status.status_code == 200
        body = status.json()
        assert body["capabilities"] == {"h264": False}
        entry = next(s for s in body["streams"] if s["stream_id"] == sid)
        assert entry["topic"] == "/cam/front"
        assert entry["state"] == "live"
        assert entry["fps"] == 0.0  # no frame fed yet -> honest zero

        offer = client.post(
            "/stream/offer",
            json={"stream_id": sid, "sdp": {"type": "offer", "sdp": "OFFER"}},
        )
        assert offer.status_code == 200
        answer = offer.json()
        assert answer["type"] == "answer"
        assert answer["sdp"] == "answer-for:OFFER"

        stopped = client.post("/stream/stop", json={"stream_id": sid})
        assert stopped.status_code == 200
        assert stopped.json() == {"stopped": True}


def test_status_fps_reflects_fed_frames() -> None:
    client, router = _fake_app()
    with client:
        sid = client.post("/stream/start", json={"topic": "/cam/front"}).json()[
            "stream_id"
        ]
        # Frames arrive over the bus (simulated) -> router fans to the stream.
        for _ in range(5):
            router.feed("/cam/front", "opaque-bgr")
        entry = next(
            s
            for s in client.get("/stream/status").json()["streams"]
            if s["stream_id"] == sid
        )
        assert entry["fps"] > 0.0


def test_duplicate_start_returns_same_stream_id() -> None:
    client, _ = _fake_app()
    with client:
        a = client.post("/stream/start", json={"topic": "/cam/front"})
        b = client.post("/stream/start", json={"topic": "/cam/front"})
        assert a.json()["stream_id"] == b.json()["stream_id"]


def test_h264_rejected_when_unavailable() -> None:
    client, _ = _fake_app()
    with client:
        resp = client.post(
            "/stream/start", json={"topic": "/cam/front", "encoding": "h264"}
        )
        assert resp.status_code == 409
        assert resp.json()["error"]["code"] == "encoding_unavailable"


def test_offer_unknown_stream_is_404() -> None:
    client, _ = _fake_app()
    with client:
        resp = client.post(
            "/stream/offer",
            json={"stream_id": "ghost", "sdp": {"type": "offer", "sdp": "x"}},
        )
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "stream_not_found"


def test_stop_unknown_stream_is_404() -> None:
    client, _ = _fake_app()
    with client:
        assert (
            client.post("/stream/stop", json={"stream_id": "ghost"}).status_code == 404
        )


def test_invalid_start_request_is_422() -> None:
    client, _ = _fake_app()
    with client:
        resp = client.post("/stream/start", json={"topic": ""})
        assert resp.status_code == 422
        assert resp.json()["error"]["code"] == "validation_error"


def test_video_defaults_fill_unset_hints() -> None:
    from dora_live.webrtc_models import VideoDefaults

    router = FrameRouter()
    seen: list[StreamStartRequest] = []

    def spy_source_factory(request: StreamStartRequest):
        from dora_live.webrtc_frame import RouterFrameSource

        seen.append(request)
        return RouterFrameSource(router, request.topic)

    app = create_webrtc_app(
        router,
        source_factory=spy_source_factory,
        peer_factory=lambda request, source: FakePeerManager(),
        h264_supported=False,
        video_defaults=VideoDefaults(max_fps=10, max_width=640),
    )
    with TestClient(app) as client:
        # No hints -> server defaults fill in.
        client.post("/stream/start", json={"topic": "/cam/a"})
        assert (seen[0].max_fps, seen[0].max_width) == (10, 640)
        # Explicit client hints always win over the defaults.
        client.post(
            "/stream/start", json={"topic": "/cam/b", "max_fps": 30, "max_width": 1280}
        )
        assert (seen[1].max_fps, seen[1].max_width) == (30, 1280)
