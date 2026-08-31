# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""RosTopicSubscriber lifecycle guards, exercised WITHOUT rclpy.

Covers the failure paths added in MON-H1 (readiness must not lie when spin-up
fails) and MON-H2 (a raised graph query must not kill the spin thread). rclpy is
never imported: ``_spin_up`` is monkeypatched and the ROS node is faked.
"""

from __future__ import annotations

import pytest
from kairos_common.monitoring.models import QosInfo
from topic_monitor.ros_subscriber import RosTopicSubscriber


class _AliveThread:
    def __init__(self) -> None:
        self.alive = True

    def is_alive(self) -> bool:
        return self.alive


def test_start_sets_up_only_after_spin_succeeds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sub = RosTopicSubscriber(["/cam"])
    calls = {"n": 0}
    thread = _AliveThread()

    def spin_up() -> None:
        calls["n"] += 1
        sub._thread = thread  # type: ignore[assignment]

    monkeypatch.setattr(sub, "_spin_up", spin_up)
    assert sub.is_up() is False
    sub.start()
    assert calls["n"] == 1
    assert sub.is_up() is True
    # Idempotent: a second start() while up does not spin again.
    sub.start()
    assert calls["n"] == 1


def test_start_keeps_readiness_false_when_spin_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sub = RosTopicSubscriber(["/cam"])

    def boom() -> None:
        raise RuntimeError("rclpy init failed")

    monkeypatch.setattr(sub, "_spin_up", boom)
    with pytest.raises(RuntimeError):
        sub.start()
    # MON-H1: _up must NOT be set when spin-up raised, so /readyz stays not-ready.
    assert sub.is_up() is False
    # Not latched into a bad state: a later successful start still comes up.
    monkeypatch.setattr(
        sub, "_spin_up", lambda: setattr(sub, "_thread", _AliveThread())
    )
    sub.start()
    assert sub.is_up() is True


def test_readiness_drops_when_executor_thread_dies(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sub = RosTopicSubscriber(["/cam"])
    thread = _AliveThread()
    monkeypatch.setattr(sub, "_spin_up", lambda: setattr(sub, "_thread", thread))
    sub.start()
    assert sub.is_up() is True
    thread.alive = False
    assert sub.is_up() is False
    assert sub.diagnostics()["state"] == "not_ready"


class _FakeNode:
    """Minimal stand-in for an rclpy Node's graph query."""

    def __init__(self, exc: Exception | None = None) -> None:
        self._exc = exc
        self.queried = 0

    def get_topic_names_and_types(self) -> list[tuple[str, list[str]]]:
        self.queried += 1
        if self._exc is not None:
            raise self._exc
        return []


def test_refresh_subscriptions_swallows_graph_errors() -> None:
    # MON-H2: an rmw error from the graph query is caught (logged), not raised —
    # otherwise it would kill the executor spin thread and freeze all metrics.
    sub = RosTopicSubscriber(["/cam"])
    node = _FakeNode(exc=RuntimeError("rmw exploded"))
    sub._node = node  # type: ignore[assignment]
    sub._refresh_subscriptions()  # must not raise
    assert node.queried == 1  # the guarded path was actually taken


def test_refresh_subscriptions_noop_without_node() -> None:
    sub = RosTopicSubscriber(["/cam"])
    sub._refresh_subscriptions()  # _node is None -> no-op, no raise


class _SubscriptionNode:
    def __init__(self) -> None:
        self.topics = [("/cam", ["sensor_msgs/msg/Image"])]
        self.fingerprint = (("publisher-a", "best_effort", "volatile", 1),)
        self.created: list[object] = []
        self.destroyed: list[object] = []

    def get_topic_names_and_types(self) -> list[tuple[str, list[str]]]:
        return self.topics

    def create_subscription(self, *_args: object, **_kwargs: object) -> object:
        handle = object()
        self.created.append(handle)
        return handle

    def destroy_subscription(self, handle: object) -> None:
        self.destroyed.append(handle)


def test_publisher_fingerprint_change_recreates_subscription(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import topic_monitor.ros_subscriber as rs

    node = _SubscriptionNode()
    sub = RosTopicSubscriber(["/cam"])
    sub._node = node  # type: ignore[assignment]
    qos = QosInfo(reliability="best_effort", durability="volatile", depth=10)
    monkeypatch.setattr(
        rs,
        "_publisher_snapshot",
        lambda current_node, _topic: ([qos], current_node.fingerprint),
    )
    monkeypatch.setattr(rs, "_to_qos_profile", lambda value: value)
    monkeypatch.setattr(rs, "_message_class", lambda value: value)
    monkeypatch.setattr(sub, "_event_callbacks", lambda _topic: None)

    sub._refresh_subscriptions()
    assert len(node.created) == 1
    sub._refresh_subscriptions()
    assert len(node.created) == 1  # stable graph does not churn subscriptions

    old_handle = node.created[0]
    node.fingerprint = (("publisher-b", "reliable", "volatile", 5),)
    sub._refresh_subscriptions()

    assert node.destroyed == [old_handle]
    assert len(node.created) == 2
    diagnostics = sub.diagnostics()
    assert diagnostics["subscription_count"] == 1
    assert diagnostics["subscriptions"][0]["publisher_count"] == 1
    assert diagnostics["subscriptions"][0]["last_sample_age_s"] is None


def test_removed_graph_topic_destroys_subscription(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import topic_monitor.ros_subscriber as rs

    node = _SubscriptionNode()
    sub = RosTopicSubscriber(["/cam"])
    sub._node = node  # type: ignore[assignment]
    qos = QosInfo(reliability="best_effort", durability="volatile", depth=10)
    monkeypatch.setattr(
        rs,
        "_publisher_snapshot",
        lambda current_node, _topic: ([qos], current_node.fingerprint),
    )
    monkeypatch.setattr(rs, "_to_qos_profile", lambda value: value)
    monkeypatch.setattr(rs, "_message_class", lambda value: value)
    monkeypatch.setattr(sub, "_event_callbacks", lambda _topic: None)

    sub._refresh_subscriptions()
    old_handle = node.created[0]
    node.topics = []
    sub._refresh_subscriptions()

    assert node.destroyed == [old_handle]
    assert sub.diagnostics()["subscription_count"] == 0


def test_diagnostics_reports_last_sample_age(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import topic_monitor.ros_subscriber as rs

    clock = [100.0]
    monkeypatch.setattr(rs.time, "monotonic", lambda: clock[0])
    node = _SubscriptionNode()
    sub = RosTopicSubscriber(["/cam"])
    sub._node = node  # type: ignore[assignment]
    qos = QosInfo(reliability="best_effort", durability="volatile", depth=10)
    monkeypatch.setattr(
        rs,
        "_publisher_snapshot",
        lambda current_node, _topic: ([qos], current_node.fingerprint),
    )
    monkeypatch.setattr(rs, "_to_qos_profile", lambda value: value)
    monkeypatch.setattr(rs, "_message_class", lambda value: value)
    monkeypatch.setattr(sub, "_event_callbacks", lambda _topic: None)
    sub.set_sink(lambda _sample: None)

    sub._refresh_subscriptions()
    callback = sub._make_callback("/cam", "sensor_msgs/msg/Image")
    clock[0] = 102.0
    callback(b"1234")
    clock[0] = 105.5

    entry = sub.diagnostics()["subscriptions"][0]
    assert entry["last_sample_age_s"] == pytest.approx(3.5)
