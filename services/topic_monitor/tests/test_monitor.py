"""MonitorService end-to-end via FakeSubscriber (no ROS).

Feeds synthetic samples through the same sink the real subscriber uses and
asserts the snapshot / topics / pause behaviour the API layer serves.
"""

from __future__ import annotations

from kairos_common import (
    Durability,
    ExpectedHzPattern,
    RecordingConfig,
    Reliability,
    TopicQosOverride,
)
from topic_monitor.models import AlertMetric, AlertOp, AlertRule
from topic_monitor.monitor import MonitorService
from topic_monitor.subscriber import FakeSubscriber, TopicGraphEntry


class FakeClock:
    """A manually-advanced monotonic clock for deterministic windows."""

    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t


def _config() -> RecordingConfig:
    return RecordingConfig(
        robot_name="hsr",
        default_topics=["/cam", "/joint_states"],
        expected_hz_patterns=[ExpectedHzPattern(pattern="/cam", hz=10.0)],
        topic_qos_overrides=[
            TopicQosOverride(
                pattern="/cam",
                reliability=Reliability.best_effort,
                durability=Durability.volatile,
                depth=1,
            )
        ],
    )


def test_snapshot_reports_hz_for_fed_samples() -> None:
    clock = FakeClock()
    sub = FakeSubscriber()
    service = MonitorService(sub, config=_config(), clock=clock)
    service.start()

    # 50 samples over 5 s (the snapshot window) on /cam -> 10 Hz.
    for i in range(50):
        clock.t = i * 0.1
        sub.feed("/cam", recv_t=clock.t, size_bytes=1000, type="sensor_msgs/msg/Image")

    clock.t = 4.9
    snap = service.metrics_snapshot()
    cam = next(t for t in snap.topics if t.name == "/cam")
    assert cam.hz is not None and abs(cam.hz - 10.0) < 0.5
    assert cam.bandwidth_bps is not None and cam.bandwidth_bps > 0
    assert cam.type == "sensor_msgs/msg/Image"
    assert snap.window_s == 5  # largest configured window
    assert snap.paused is False


def test_seeded_allowlist_topic_reports_zero_hz_when_silent() -> None:
    clock = FakeClock()
    service = MonitorService(FakeSubscriber(), config=_config(), clock=clock)
    service.start()
    snap = service.metrics_snapshot()
    names = {t.name for t in snap.topics}
    # Concrete default_topics are seeded even with no samples.
    assert {"/cam", "/joint_states"} <= names
    js = next(t for t in snap.topics if t.name == "/joint_states")
    assert js.hz == 0.0


def test_pause_blocks_samples_then_resume_restores() -> None:
    clock = FakeClock()
    sub = FakeSubscriber()
    service = MonitorService(sub, config=_config(), clock=clock)
    service.start()

    assert service.pause() is True
    assert service.paused is True
    # FakeSubscriber.emit is a no-op while paused, so this sample is dropped.
    sub.feed("/cam", recv_t=0.0, size_bytes=100)
    snap = service.metrics_snapshot()
    cam = next(t for t in snap.topics if t.name == "/cam")
    assert cam.hz == 0.0
    assert snap.paused is True

    assert service.resume() is False
    assert service.paused is False
    clock.t = 1.0
    sub.feed("/cam", recv_t=1.0, size_bytes=100)
    cam2 = next(t for t in service.metrics_snapshot().topics if t.name == "/cam")
    assert cam2.hz is not None and cam2.hz > 0.0


def test_topics_merges_graph_and_state() -> None:
    graph = [
        TopicGraphEntry(
            name="/cam",
            type="sensor_msgs/msg/Image",
            publisher_count=1,
            subscriber_count=2,
        )
    ]
    sub = FakeSubscriber(graph=graph)
    service = MonitorService(sub, config=_config())
    service.start()
    sub.feed("/cam", recv_t=0.0, size_bytes=10, type="sensor_msgs/msg/Image")

    resp = service.topics()
    cam = next(t for t in resp.topics if t.name == "/cam")
    assert cam.publisher_count == 1
    assert cam.subscriber_count == 2
    assert cam.type == "sensor_msgs/msg/Image"
    assert cam.last_seen is not None  # a sample has arrived


def test_alert_fires_in_snapshot_when_hz_below_threshold() -> None:
    clock = FakeClock()
    sub = FakeSubscriber()
    rule = AlertRule(topic="/cam", metric=AlertMetric.hz, op=AlertOp.lt, threshold=5.0)
    service = MonitorService(sub, config=_config(), alert_rules=[rule], clock=clock)
    service.start()
    # A single sample -> hz ~ 1/window, well below 5 Hz.
    sub.feed("/cam", recv_t=0.0, size_bytes=10)
    snap = service.metrics_snapshot()
    assert any(a.topic == "/cam" for a in snap.alerts)


def test_is_ready_reflects_subscriber_liveness() -> None:
    sub = FakeSubscriber()
    service = MonitorService(sub, config=_config())
    assert service.is_ready() is False
    service.start()
    assert service.is_ready() is True
    service.stop()
    assert service.is_ready() is False
