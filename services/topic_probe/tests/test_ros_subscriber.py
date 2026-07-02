"""ROS-free tests for the rclpy subscriber's pure bookkeeping.

``RosProbeSubscriber`` imports rclpy lazily (only in ``start``/``_spin_up``), so
its ref-count and unresolved-type rate-limit logic can be exercised without ROS.
"""

from __future__ import annotations

import pytest
from topic_probe.ros_subscriber import RosProbeSubscriber


def test_unsubscribe_is_defensive() -> None:
    """Double / never unsubscribe is a no-op, not a KeyError (PRB-L1).

    ``subscribe`` / ``unsubscribe`` only touch the desired Counter (the reconcile
    timer does the ROS work), so this runs without rclpy.
    """
    sub = RosProbeSubscriber()
    sub.subscribe("/a")
    sub.subscribe("/a")
    sub.unsubscribe("/a")
    assert sub.subscribed_topics() == ["/a"]  # one ref left
    sub.unsubscribe("/a")
    assert sub.subscribed_topics() == []
    # No live reference: a further release (double unsubscribe / lost race) and an
    # unsubscribe of a never-held topic must both be no-ops.
    sub.unsubscribe("/a")
    sub.unsubscribe("/never")
    assert sub.subscribed_topics() == []


def test_unresolved_type_warning_is_rate_limited(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An unresolved-type topic warns once, then drops to DEBUG within the period
    (PRB-M2) — the 20 Hz reconcile can't flood the log with ~20 warnings/second."""
    import topic_probe.ros_subscriber as rs

    warns: list[str] = []
    debugs: list[str] = []
    monkeypatch.setattr(rs.logger, "warning", lambda *a, **k: warns.append(a[1]))
    monkeypatch.setattr(rs.logger, "debug", lambda *a, **k: debugs.append(a[1]))

    sub = RosProbeSubscriber()
    for _ in range(5):
        sub._warn_unresolved_type("/x")
    assert warns == ["/x"]  # only the first sighting warns
    assert debugs == ["/x", "/x", "/x", "/x"]  # the rest are debug


def test_unresolved_type_warning_reemits_after_period(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Once ``_TYPE_WARN_PERIOD_S`` elapses the warning re-emits (still bounded)."""
    import topic_probe.ros_subscriber as rs

    clock = [1000.0]
    monkeypatch.setattr(rs.time, "monotonic", lambda: clock[0])
    warns: list[str] = []
    monkeypatch.setattr(rs.logger, "warning", lambda *a, **k: warns.append(a[1]))
    monkeypatch.setattr(rs.logger, "debug", lambda *a, **k: None)

    sub = RosProbeSubscriber()
    sub._warn_unresolved_type("/x")  # first sighting -> warn
    clock[0] += rs._TYPE_WARN_PERIOD_S + 1.0
    sub._warn_unresolved_type("/x")  # period elapsed -> warn again
    clock[0] += 1.0
    sub._warn_unresolved_type("/x")  # within the new period -> debug
    assert warns == ["/x", "/x"]
