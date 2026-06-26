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


def test_fields_introspects_active_topic_message() -> None:
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


def test_fields_reports_reason_when_no_message() -> None:
    service, _ = _service([TopicMeta(name="/quiet", type="std_msgs/msg/Float64")])
    # wait_s=0 so the test does not block waiting for a message that never comes.
    resp = service.fields("/quiet", wait_s=0.0)
    assert resp.fields == []
    assert resp.reason is not None


def test_sample_extracts_field_value() -> None:
    service, sub = _service([TopicMeta(name="/pose", type="geometry_msgs/msg/Pose")])
    sub.set_message("/pose", SimpleNamespace(position=SimpleNamespace(x=4.2, y=0.0)))
    sample = service.sample("/pose", "position.x")
    assert sample.topic == "/pose"
    assert sample.field == "position.x"
    assert sample.value == 4.2
    assert sample.t > 0


def test_sample_value_none_before_message() -> None:
    service, _ = _service([TopicMeta(name="/pose", type="geometry_msgs/msg/Pose")])
    sample = service.sample("/pose", "position.x")
    assert sample.value is None


def test_selecting_a_topic_makes_it_active() -> None:
    service, sub = _service()
    service.sample("/x", "a")
    assert sub.active_topic() == "/x"
