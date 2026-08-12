# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""App-level tests: the FastAPI app boots and serves WITHOUT rclpy installed.

Proves the lazy-import guard — importing ``topic_probe.main`` and serving the
topics/fields/sample endpoints needs no ROS. The default app builds the
rclpy-backed subscriber (whose rclpy import is deferred to ``start``); the wiring
tests here inject a ``FakeProbeSubscriber`` so the full request path runs natively.
"""

from __future__ import annotations

import sys
from types import SimpleNamespace

from fastapi.testclient import TestClient
from topic_probe.main import app, create_probe_app
from topic_probe.subscriber import FakeProbeSubscriber, TopicMeta


def test_rclpy_not_importable_in_test_env() -> None:
    # The whole point of the lazy-import guard: these tests run with no ROS.
    assert "rclpy" not in sys.modules


def test_default_app_healthz_without_ros() -> None:
    # The module-level app builds the real (rclpy-backed) subscriber, but rclpy
    # is only imported on start(); health must answer regardless.
    client = TestClient(app)
    resp = client.get("/healthz")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def _fake_app() -> tuple[TestClient, FakeProbeSubscriber]:
    sub = FakeProbeSubscriber(
        graph=[TopicMeta(name="/pose", type="geometry_msgs/msg/Pose")]
    )
    sub.set_message(
        "/pose", SimpleNamespace(position=SimpleNamespace(x=1.0, y=2.0, z=3.0))
    )
    return TestClient(create_probe_app(subscriber=sub)), sub


def test_topics_fields_sample_with_fake_subscriber() -> None:
    client, _ = _fake_app()
    # Entering the context manager runs lifespan startup (service.start()).
    with client:
        topics = client.get("/topics")
        assert topics.status_code == 200
        assert any(t["name"] == "/pose" for t in topics.json()["topics"])

        fields = client.get("/fields", params={"topic": "/pose"})
        assert fields.status_code == 200
        body = fields.json()
        assert body["topic"] == "/pose"
        assert "position.x" in body["fields"]

        sample = client.get("/sample", params={"topic": "/pose", "field": "position.x"})
        assert sample.status_code == 200
        assert sample.json()["value"] == 1.0

        ready = client.get("/readyz")
        assert ready.status_code == 200
        assert ready.json()["status"] == "ready"


def test_fields_requires_topic_param() -> None:
    client, _ = _fake_app()
    with client:
        resp = client.get("/fields")
        assert resp.status_code == 422


def test_sample_requires_topic_and_field() -> None:
    client, _ = _fake_app()
    with client:
        assert client.get("/sample", params={"topic": "/pose"}).status_code == 422


def test_readyz_not_ready_before_start() -> None:
    sub = FakeProbeSubscriber()
    client = TestClient(create_probe_app(subscriber=sub))
    # Without entering the lifespan, the subscriber is not up.
    resp = client.get("/readyz")
    assert resp.status_code == 503
    assert resp.json()["status"] == "not_ready"


def test_stream_releases_subscription_on_disconnect() -> None:
    """The SSE generator holds its subscription for the connection and releases it
    on disconnect — even one right after subscribing (PRB-M1).

    The subscribe now runs inside the generator's try/finally, so a client that
    drops mid-stream still reaches the finally and unsubscribes (previously the
    subscribe was outside the try and the reference leaked permanently).
    """
    import asyncio

    from topic_probe.main import _multi_sample_sse
    from topic_probe.probe import ProbeService

    sub = FakeProbeSubscriber(
        graph=[TopicMeta(name="/pose", type="geometry_msgs/msg/Pose")]
    )
    sub.set_message("/pose", SimpleNamespace(position=SimpleNamespace(x=1.0)))
    service = ProbeService(sub)
    service.start()

    async def drive() -> None:
        gen = _multi_sample_sse(service, "/pose", ["position.x"], interval=0.01)
        frame = await gen.__anext__()  # first frame: subscribed + streaming
        assert "position.x" in frame
        assert sub.subscribed_topics() == ["/pose"]
        await gen.aclose()  # client disconnects -> finally releases the sub
        assert sub.subscribed_topics() == []

    asyncio.run(drive())
