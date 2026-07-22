"""Live-frames lane: eligibility gate, sampling, store semantics, pull API."""

import base64

from dora_live.frames_lane import (
    FrameStore,
    SampleGate,
    content_type,
    frame_eligible,
)
from dora_live.nodes.frames import payload_bytes


def test_frame_eligible_image_always():
    assert frame_eligible("image", None)
    assert frame_eligible("image", 0)


def test_frame_eligible_ffmpeg_keyframes_only():
    assert frame_eligible("ffmpeg", 1)
    assert frame_eligible("ffmpeg", 3)
    assert not frame_eligible("ffmpeg", 0)
    assert not frame_eligible("ffmpeg", None)  # unproven != keyframe
    assert not frame_eligible("ffmpeg", "junk")


def test_frame_eligible_raw_never():
    assert not frame_eligible("raw", 1)
    assert not frame_eligible(None, 1)


def test_sample_gate_caps_per_topic():
    gate = SampleGate(2.0)
    t = 100.0
    gate._clock = lambda: t
    assert gate.allow("/a") is True
    assert gate.allow("/a") is False  # same instant: capped
    assert gate.allow("/b") is True  # other topics independent
    t += 0.5
    assert gate.allow("/a") is True  # 1/sample_hz elapsed


def test_frame_store_latest_wins_and_seq():
    store = FrameStore()
    s1 = store.put(
        "/cam", codec="image", encoding="jpeg", data=b"one", stamp_ns=5, recv_t=1.0
    )
    s2 = store.put(
        "/cam", codec="image", encoding="jpeg", data=b"two", stamp_ns=6, recv_t=2.0
    )
    assert s2 > s1
    record = store.get("/cam")
    assert record.data == b"two" and record.seq == s2
    assert store.get("/nope") is None
    (row,) = store.index()
    assert row["topic"] == "/cam" and row["size_bytes"] == 3 and "data" not in row


def test_content_type_mapping():
    assert content_type("image", "jpeg") == "image/jpeg"
    assert content_type("image", "png") == "image/png"
    assert content_type("ffmpeg", "libx264") == "application/octet-stream"


def test_payload_bytes_normalises_arrow_lists():
    assert payload_bytes({"data": b"x"}) == b"x"
    assert payload_bytes({"data": [1, 2, 3]}) == b"\x01\x02\x03"
    assert payload_bytes({}) is None


def test_control_frames_routes():
    from dora_live.control import create_control_app
    from dora_live.feed_subscriber import DoraFeedSubscriber
    from fastapi.testclient import TestClient

    app = create_control_app(
        subscriber=DoraFeedSubscriber(enable_rclpy=False), config=None
    )
    with TestClient(app) as client:
        assert client.get("/live/frames").json()["frames"] == []
        assert client.get("/live/frame", params={"topic": "/cam"}).status_code == 404

        body = {
            "topic": "/cam",
            "codec": "image",
            "encoding": "jpeg",
            "stamp_ns": 123,
            "recv_t": 4.5,
            "data_b64": base64.b64encode(b"jpegbytes").decode(),
        }
        seq = client.post("/internal/frames", json=body).json()["seq"]

        index = client.get("/live/frames").json()["frames"]
        assert index[0]["topic"] == "/cam" and index[0]["seq"] == seq

        got = client.get("/live/frame", params={"topic": "/cam"})
        assert got.status_code == 200
        assert got.content == b"jpegbytes"
        assert got.headers["content-type"].startswith("image/jpeg")
        assert got.headers["ETag"] == f'"{seq}"'
        assert got.headers["X-Frame-Stamp-Ns"] == "123"

        # Conditional GET: unchanged frame -> 304, no payload re-transfer.
        not_modified = client.get(
            "/live/frame",
            params={"topic": "/cam"},
            headers={"If-None-Match": f'"{seq}"'},
        )
        assert not_modified.status_code == 304
