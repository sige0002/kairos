# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Service-level tests for ProbeService driven by the FakeProbeSubscriber (no ROS)."""

from __future__ import annotations

from types import SimpleNamespace

from topic_probe.probe import ProbeService
from topic_probe.subscriber import FakeProbeSubscriber, TopicMeta


def _service(
    graph: list[TopicMeta] | None = None,
) -> tuple[ProbeService, FakeProbeSubscriber]:
    sub = FakeProbeSubscriber(graph=graph)
    service = ProbeService(sub)
    service.start()
    return service, sub


def test_topics_sorted_by_name() -> None:
    service, _ = _service(
        [
            TopicMeta(name="/b", type="std_msgs/msg/Float64"),
            TopicMeta(name="/a", type="sensor_msgs/msg/JointState"),
        ]
    )
    resp = service.topics()
    assert [t.name for t in resp.topics] == ["/a", "/b"]
    assert resp.topics[0].type == "sensor_msgs/msg/JointState"


def test_fields_introspects_topic_message() -> None:
    service, sub = _service([TopicMeta(name="/pose", type="geometry_msgs/msg/Pose")])
    sub.set_message(
        "/pose",
        SimpleNamespace(position=SimpleNamespace(x=1.0, y=2.0, z=3.0)),
    )
    resp = service.fields("/pose")
    assert resp.topic == "/pose"
    assert resp.type == "geometry_msgs/msg/Pose"
    assert resp.fields == ["position.x", "position.y", "position.z"]
    assert resp.reason is None
    # fields() holds only a transient subscription — released afterwards.
    assert sub.subscribed_topics() == []


def test_fields_reports_reason_when_no_message() -> None:
    service, _ = _service([TopicMeta(name="/quiet", type="std_msgs/msg/Float64")])
    # wait_s=0 so the test does not block waiting for a message that never comes.
    resp = service.fields("/quiet", wait_s=0.0)
    assert resp.fields == []
    assert resp.reason is not None


def test_sample_reads_subscribed_topic() -> None:
    service, sub = _service([TopicMeta(name="/pose", type="geometry_msgs/msg/Pose")])
    sub.set_message("/pose", SimpleNamespace(position=SimpleNamespace(x=4.2, y=0.0)))
    service.subscribe("/pose")
    sample = service.sample("/pose", "position.x")
    assert sample.topic == "/pose"
    assert sample.field == "position.x"
    assert sample.value == 4.2
    assert sample.t > 0


def test_sample_value_none_before_message() -> None:
    service, _ = _service([TopicMeta(name="/pose", type="geometry_msgs/msg/Pose")])
    service.subscribe("/pose")
    sample = service.sample("/pose", "position.x")
    assert sample.value is None


def test_sample_many_overlays_multiple_fields() -> None:
    service, sub = _service([TopicMeta(name="/pose", type="geometry_msgs/msg/Pose")])
    sub.set_message(
        "/pose", SimpleNamespace(position=SimpleNamespace(x=1.0, y=2.0, z=3.0))
    )
    service.subscribe("/pose")
    ms = service.sample_many("/pose", ["position.x", "position.z", "position.nope"])
    assert ms.topic == "/pose"
    assert ms.values == {"position.x": 1.0, "position.z": 3.0, "position.nope": None}


def test_subscribe_is_ref_counted() -> None:
    service, sub = _service([TopicMeta(name="/a"), TopicMeta(name="/b")])
    service.subscribe("/a")
    service.subscribe("/a")
    service.subscribe("/b")
    assert set(sub.subscribed_topics()) == {"/a", "/b"}
    assert service.subscribed_count() == 2
    service.unsubscribe("/a")  # one ref left on /a
    assert set(sub.subscribed_topics()) == {"/a", "/b"}
    service.unsubscribe("/a")  # /a released
    assert set(sub.subscribed_topics()) == {"/b"}


def test_sample_blocking_one_shot_subscribes_and_releases() -> None:
    service, sub = _service([TopicMeta(name="/pose", type="geometry_msgs/msg/Pose")])
    sub.set_message("/pose", SimpleNamespace(position=SimpleNamespace(x=5.0)))
    s = service.sample_blocking("/pose", "position.x")
    assert s.value == 5.0
    # The one-shot releases its transient subscription.
    assert sub.subscribed_topics() == []


def test_double_unsubscribe_is_noop() -> None:
    """Unsubscribing a topic with no live reference is a no-op, not a KeyError
    (PRB-L1) — a disconnect-cleanup path can double-release safely."""
    service, sub = _service([TopicMeta(name="/a")])
    service.subscribe("/a")
    service.unsubscribe("/a")  # released
    assert sub.subscribed_topics() == []
    # Second release (double unsubscribe) and an unsubscribe of a never-held
    # topic must both be no-ops.
    service.unsubscribe("/a")
    service.unsubscribe("/never-subscribed")
    assert sub.subscribed_topics() == []
