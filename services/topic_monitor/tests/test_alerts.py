"""Alert engine: condition firing + cooldown / clear_after hysteresis."""

from __future__ import annotations

from topic_monitor.alerts import AlertEngine, metric_value
from topic_monitor.models import AlertMetric, AlertOp, AlertRule


def _snapshot(hz: float | None) -> dict[str, dict[str, object]]:
    return {"/cam": {"name": "/cam", "hz": hz, "inter_arrival_late_ratio": None}}


def test_metric_value_maps_late_to_inter_arrival_ratio() -> None:
    topic = {"hz": 10.0, "inter_arrival_late_ratio": 0.4, "loss_rate": None}
    assert metric_value(AlertMetric.hz, topic) == 10.0
    assert metric_value(AlertMetric.late, topic) == 0.4
    # Null metric -> not computable -> None.
    assert metric_value(AlertMetric.loss, topic) is None


def test_alert_fires_when_condition_holds() -> None:
    rule = AlertRule(topic="/cam", metric=AlertMetric.hz, op=AlertOp.lt, threshold=20.0)
    engine = AlertEngine([rule])
    firing = engine.evaluate(_snapshot(hz=5.0), now=0.0, ts_iso="T0")
    assert len(firing) == 1
    assert firing[0].topic == "/cam"
    assert firing[0].value == 5.0
    assert firing[0].since == "T0"


def test_alert_does_not_fire_when_condition_false() -> None:
    rule = AlertRule(topic="/cam", metric=AlertMetric.hz, op=AlertOp.lt, threshold=20.0)
    engine = AlertEngine([rule])
    assert engine.evaluate(_snapshot(hz=30.0), now=0.0, ts_iso="T0") == []


def test_clear_after_keeps_firing_until_false_long_enough() -> None:
    rule = AlertRule(
        topic="/cam",
        metric=AlertMetric.hz,
        op=AlertOp.lt,
        threshold=20.0,
        clear_after_s=2.0,
    )
    engine = AlertEngine([rule])
    # Fires at t=0 (hz below threshold).
    assert len(engine.evaluate(_snapshot(5.0), now=0.0, ts_iso="T0")) == 1
    # Condition goes false at t=1, but clear_after_s=2 not yet elapsed -> still firing.
    assert len(engine.evaluate(_snapshot(30.0), now=1.0, ts_iso="T1")) == 1
    # At t=2.5 it has been false for 1.5s -> still firing (< 2.0).
    assert len(engine.evaluate(_snapshot(30.0), now=2.5, ts_iso="T2")) == 1
    # At t=3.1 it has been false for 2.1s (>= 2.0) -> clears.
    assert engine.evaluate(_snapshot(30.0), now=3.1, ts_iso="T3") == []


def test_cooldown_suppresses_immediate_refire() -> None:
    rule = AlertRule(
        topic="/cam",
        metric=AlertMetric.hz,
        op=AlertOp.lt,
        threshold=20.0,
        clear_after_s=0.0,
        cooldown_s=5.0,
    )
    engine = AlertEngine([rule])
    # Fire, then clear immediately (clear_after_s=0) at t=1.
    assert len(engine.evaluate(_snapshot(5.0), now=0.0, ts_iso="T0")) == 1
    assert engine.evaluate(_snapshot(30.0), now=1.0, ts_iso="T1") == []
    # Condition true again at t=2, but within the 5s cooldown -> suppressed.
    assert engine.evaluate(_snapshot(5.0), now=2.0, ts_iso="T2") == []
    # After cooldown (t=7) it may fire again.
    assert len(engine.evaluate(_snapshot(5.0), now=7.0, ts_iso="T3")) == 1


def test_since_is_stable_across_consecutive_firing_ticks() -> None:
    rule = AlertRule(topic="/cam", metric=AlertMetric.hz, op=AlertOp.lt, threshold=20.0)
    engine = AlertEngine([rule])
    first = engine.evaluate(_snapshot(5.0), now=0.0, ts_iso="T0")
    second = engine.evaluate(_snapshot(6.0), now=1.0, ts_iso="T1")
    # The "since" timestamp is when it started firing, not the latest tick.
    assert first[0].since == "T0"
    assert second[0].since == "T0"
