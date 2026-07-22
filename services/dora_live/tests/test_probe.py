"""ProbeHub semantics and the probe-compatible app contract."""

import threading
import time

from dora_live.feed_subscriber import DoraFeedSubscriber
from dora_live.probe_app import create_probe_compat_app
from dora_live.probe_state import ProbeHub
from fastapi.testclient import TestClient
from kairos_common.monitoring import TopicGraphEntry


def test_hub_refcount_and_active_set():
    hub = ProbeHub()
    hub.acquire("/x", ["a.b"])
    hub.acquire("/x", ["c"])
    active = hub.active()
    assert active["topics"] == {"/x": ["a.b", "c"]}
    hub.release("/x", ["a.b"])
    assert "/x" in hub.active()["topics"]
    hub.release("/x", ["c"])
    assert hub.active()["topics"] == {}


def test_hub_wait_for_field_skips_stale_push():
    hub = ProbeHub()
    hub.acquire("/x", ["a"])
    # stale push from an older active-set (field "b" only)
    hub.push_values("/x", 1.0, {"b": 2.0})

    def _push_fresh():
        time.sleep(0.1)
        hub.push_values("/x", 2.0, {"a": 1.0, "b": 2.0})

    threading.Thread(target=_push_fresh).start()
    got = hub.wait_for_field("/x", "a", timeout=2.0)
    assert got is not None and got["values"]["a"] == 1.0


def test_hub_wait_for_unblocks_on_push():
    hub = ProbeHub()
    hub.acquire("/x", ["v"])

    def _push():
        time.sleep(0.05)
        hub.push_values("/x", 12.5, {"v": 3.0})

    threading.Thread(target=_push).start()
    got = hub.wait_for("/x", timeout=2.0)
    assert got is not None and got["values"]["v"] == 3.0


def _probe_client() -> tuple[TestClient, ProbeHub, DoraFeedSubscriber]:
    hub = ProbeHub()
    feed = DoraFeedSubscriber(enable_discovery=False)
    feed.start()
    feed._graph = [TopicGraphEntry(name="/x", type="std_msgs/msg/Float64")]
    feed.set_topic_types({"/x": "std_msgs/msg/Float64"})  # bridged
    app = create_probe_compat_app(hub=hub, feed=feed)
    return TestClient(app), hub, feed


def test_probe_topics_and_fields_flow():
    client, hub, _ = _probe_client()
    with client:
        topics = client.get("/topics").json()["topics"]
        assert topics == [
            {"name": "/x", "type": "std_msgs/msg/Float64", "bridged": True}
        ]

        # fields: node pushes the introspection result while the app waits
        def _answer():
            deadline = time.monotonic() + 2.0
            while time.monotonic() < deadline:
                if "/x" in hub.active()["introspect"]:
                    hub.push_fields("/x", ["data"], None)
                    return
                time.sleep(0.02)

        threading.Thread(target=_answer).start()
        body = client.get("/fields", params={"topic": "/x"}).json()
        assert body["fields"] == ["data"]
        assert body["reason"] is None


def test_probe_sample_flow():
    client, hub, _ = _probe_client()
    with client:

        def _answer():
            deadline = time.monotonic() + 2.0
            while time.monotonic() < deadline:
                if "/x" in hub.active()["topics"]:
                    hub.push_values("/x", 99.0, {"data": 42.0})
                    return
                time.sleep(0.02)

        threading.Thread(target=_answer).start()
        body = client.get("/sample", params={"topic": "/x", "field": "data"}).json()
        assert body == {"topic": "/x", "field": "data", "t": 99.0, "value": 42.0}
        # one-shot released its ref
        assert hub.active()["topics"] == {}


def test_probe_readyz_tracks_dataflow():
    hub = ProbeHub()
    feed = DoraFeedSubscriber(enable_discovery=False)
    feed.start()
    alive = {"v": True}
    app = create_probe_compat_app(hub=hub, feed=feed, dataflow_alive=lambda: alive["v"])
    with TestClient(app) as client:
        assert client.get("/readyz").status_code == 200
        alive["v"] = False
        assert client.get("/readyz").status_code == 503
