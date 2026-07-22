"""Control app: monitor-compatible contract + the internal feed endpoint.

Requires kairos_common.monitoring (the engine extracted from topic_monitor);
drives the full metric path through HTTP without ROS or dora.
"""

import time

from dora_live.control import create_control_app
from dora_live.feed_subscriber import DoraFeedSubscriber
from fastapi.testclient import TestClient
from kairos_common.monitoring import TopicGraphEntry


def _client() -> tuple[TestClient, DoraFeedSubscriber]:
    feed = DoraFeedSubscriber(enable_discovery=False)
    app = create_control_app(
        subscriber=feed,
        config=None,
        live_status=lambda: {"topics": ["/x"], "pending": [], "degraded": False},
    )
    return TestClient(app), feed


def test_monitor_contract_surface():
    client, feed = _client()
    with client:
        feed.set_topic_types({"/x": "std_msgs/msg/String"})
        now = time.monotonic()
        rows = [
            {"topic": "/x", "recv_t": now - 0.2 + i * 0.1, "size": 64, "bridged": True}
            for i in range(3)
        ]
        assert client.post("/internal/samples", json={"rows": rows}).json() == {
            "delivered": 3
        }

        snap = client.get("/metrics").json()
        names = [t["name"] for t in snap["topics"]]
        assert "/x" in names
        topic = next(t for t in snap["topics"] if t["name"] == "/x")
        # quick_check-critical keys stay present (contract with orchestrator)
        for key in ("hz", "rate_shortfall", "gap_max_ms", "dds_samples_lost"):
            assert key in topic

        assert client.get("/alerts").status_code == 200
        assert client.get("/incidents").status_code == 200
        assert client.post("/metrics/pause").json()["paused"] is True
        assert client.post("/metrics/resume").json()["paused"] is False

        status = client.get("/live/status").json()
        assert status["metrics_source"] == "dora_bridge"
        assert status["dds_samples_lost_available"] is False

        # Analysis event lane (extension seam): push -> ring -> since filter
        event = {
            "detector": "custom",
            "topic": "/x",
            "t": 100.0,
            "severity": "warn",
            "message": "demo",
        }
        assert client.post("/internal/analysis/events", json=event).json() == {
            "ok": True
        }
        assert client.get("/live/events").json()["events"] == [event]
        assert client.get("/live/events", params={"since": 200}).json()["events"] == []


def test_topics_reflects_discovery_graph():
    client, feed = _client()
    with client:
        feed._graph = [  # test hook: poller disabled, inject graph directly
            TopicGraphEntry(name="/x", type="std_msgs/msg/String", publisher_count=1)
        ]
        topics = client.get("/topics").json()["topics"]
        assert topics and topics[0]["name"] == "/x"


def test_readyz_reflects_subscriber_state():
    feed = DoraFeedSubscriber(enable_discovery=False)
    app = create_control_app(subscriber=feed, config=None)
    with TestClient(app) as client:
        # lifespan started the subscriber -> ready
        assert client.get("/readyz").status_code == 200
        feed.stop()
        assert client.get("/readyz").status_code == 503
