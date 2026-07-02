"""RosTopicSubscriber lifecycle guards, exercised WITHOUT rclpy.

Covers the failure paths added in MON-H1 (readiness must not lie when spin-up
fails) and MON-H2 (a raised graph query must not kill the spin thread). rclpy is
never imported: ``_spin_up`` is monkeypatched and the ROS node is faked.
"""

from __future__ import annotations

import pytest
from topic_monitor.ros_subscriber import RosTopicSubscriber


def test_start_sets_up_only_after_spin_succeeds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sub = RosTopicSubscriber(["/cam"])
    calls = {"n": 0}
    monkeypatch.setattr(sub, "_spin_up", lambda: calls.__setitem__("n", calls["n"] + 1))
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
    monkeypatch.setattr(sub, "_spin_up", lambda: None)
    sub.start()
    assert sub.is_up() is True


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
