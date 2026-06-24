"""App-level tests: the FastAPI app boots and serves WITHOUT rclpy installed.

Proves the lazy-import guard — importing ``topic_monitor.main`` and serving the
metrics/topics endpoints needs no ROS. The default app uses the rclpy-backed
subscriber (whose rclpy import is deferred to ``start``); the wiring tests here
inject a ``FakeSubscriber`` so the full request path runs natively.
"""

from __future__ import annotations

import sys

from fastapi.testclient import TestClient
from topic_monitor.main import app, create_monitor_app
from topic_monitor.subscriber import FakeSubscriber, TopicGraphEntry


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


def test_metrics_and_topics_endpoints_with_fake_subscriber() -> None:
    graph = [
        TopicGraphEntry(name="/cam", type="sensor_msgs/msg/Image", publisher_count=1)
    ]
    sub = FakeSubscriber(graph=graph)
    fake_app = create_monitor_app(subscriber=sub)

    # Entering the context manager runs the lifespan startup (service.start()),
    # which for the fake subscriber needs no ROS.
    with TestClient(fake_app) as client:
        sub.feed("/cam", recv_t=0.0, size_bytes=1000, type="sensor_msgs/msg/Image")

        metrics = client.get("/metrics")
        assert metrics.status_code == 200
        body = metrics.json()
        assert "ts" in body and "topics" in body
        assert any(t["name"] == "/cam" for t in body["topics"])

        topics = client.get("/topics")
        assert topics.status_code == 200
        assert any(t["name"] == "/cam" for t in topics.json()["topics"])

        # readyz reflects subscriber liveness (started by lifespan).
        ready = client.get("/readyz")
        assert ready.status_code == 200
        assert ready.json()["status"] == "ready"


def test_pause_resume_endpoints() -> None:
    sub = FakeSubscriber()
    fake_app = create_monitor_app(subscriber=sub)
    with TestClient(fake_app) as client:
        paused = client.post("/metrics/pause")
        assert paused.status_code == 200
        assert paused.json() == {"paused": True}

        resumed = client.post("/metrics/resume")
        assert resumed.status_code == 200
        assert resumed.json() == {"paused": False}


def test_readyz_not_ready_before_start() -> None:
    # Without entering the lifespan (bare TestClient), the subscriber is not up.
    sub = FakeSubscriber()
    fake_app = create_monitor_app(subscriber=sub)
    client = TestClient(fake_app)
    resp = client.get("/readyz")
    assert resp.status_code == 503
    assert resp.json()["status"] == "not_ready"
