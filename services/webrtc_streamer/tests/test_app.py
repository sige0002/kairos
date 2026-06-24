"""App-level tests: the FastAPI app boots and serves WITHOUT rclpy installed.

Proves the lazy-import guard — importing ``webrtc_streamer.main`` and serving the
signaling endpoints needs no ROS. The default app uses the rclpy/aiortc-backed
factories (which import their heavy deps only when a stream starts); the wiring
tests here inject fake factories so the full request path runs natively.
"""

from __future__ import annotations

import sys

from fastapi.testclient import TestClient
from webrtc_streamer.main import app, create_streamer_app
from webrtc_streamer.models import StreamStartRequest
from webrtc_streamer.peer import FakePeerManager
from webrtc_streamer.source import FakeFrameSource


def test_rclpy_not_importable_in_test_env() -> None:
    assert "rclpy" not in sys.modules


def test_default_app_healthz_without_ros() -> None:
    client = TestClient(app)
    resp = client.get("/healthz")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def _fake_app() -> TestClient:
    def source_factory(request: StreamStartRequest) -> FakeFrameSource:
        return FakeFrameSource(fps=15.0)

    def peer_factory(
        request: StreamStartRequest, source: FakeFrameSource
    ) -> FakePeerManager:
        return FakePeerManager()

    fake_app = create_streamer_app(
        source_factory=source_factory, peer_factory=peer_factory
    )
    return TestClient(fake_app)


def test_start_status_offer_stop_flow() -> None:
    with _fake_app() as client:
        started = client.post("/stream/start", json={"topic": "/cam/front"})
        assert started.status_code == 201
        sid = started.json()["stream_id"]

        status = client.get("/stream/status")
        assert status.status_code == 200
        body = status.json()
        assert "capabilities" in body
        assert any(s["stream_id"] == sid for s in body["streams"])

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


def test_duplicate_start_returns_same_stream_id() -> None:
    with _fake_app() as client:
        a = client.post("/stream/start", json={"topic": "/cam/front"})
        b = client.post("/stream/start", json={"topic": "/cam/front"})
        assert a.json()["stream_id"] == b.json()["stream_id"]


def test_offer_unknown_stream_is_404() -> None:
    with _fake_app() as client:
        resp = client.post(
            "/stream/offer",
            json={"stream_id": "ghost", "sdp": {"type": "offer", "sdp": "x"}},
        )
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "stream_not_found"


def test_stop_unknown_stream_is_404() -> None:
    with _fake_app() as client:
        resp = client.post("/stream/stop", json={"stream_id": "ghost"})
        assert resp.status_code == 404


def test_invalid_start_request_is_422() -> None:
    with _fake_app() as client:
        # Empty topic violates min_length=1.
        resp = client.post("/stream/start", json={"topic": ""})
        assert resp.status_code == 422
        assert resp.json()["error"]["code"] == "validation_error"
