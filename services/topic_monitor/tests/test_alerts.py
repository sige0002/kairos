"""Alert engine: incident firing + cooldown / clear_after hysteresis,
cleared-state retention, and the default DANGER incident (D-9 ③)."""

from __future__ import annotations

from topic_monitor.alerts import AlertEngine, metric_value
from topic_monitor.models import AlertMetric, AlertOp, AlertRule


def _snapshot(hz: float | None) -> dict[str, dict[str, object]]:
    return {"/cam": {"name": "/cam", "hz": hz, "inter_arrival_late_ratio": None}}


def _danger(hz: float, *, status: str = "danger", deficit: float = 22.0) -> dict:
    return {
        "/cam": {"name": "/cam", "hz": hz, "status": status, "deficit_per_s": deficit}
    }


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
    assert firing[0].state == "firing"
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
    engine = AlertEngine([rule], clear_retain_s=5.0)
    # Fires at t=0 (hz below threshold).
    assert engine.evaluate(_snapshot(5.0), now=0.0, ts_iso="T0")[0].state == "firing"
    # Condition goes false at t=1, but clear_after_s=2 not yet elapsed -> still firing.
    assert engine.evaluate(_snapshot(30.0), now=1.0, ts_iso="T1")[0].state == "firing"
    # At t=2.5 it has been false for 1.5s -> still firing (< 2.0).
    assert engine.evaluate(_snapshot(30.0), now=2.5, ts_iso="T2")[0].state == "firing"
    # At t=3.1 it has been false for 2.1s (>= 2.0) -> clears (a cleared incident).
    cleared = engine.evaluate(_snapshot(30.0), now=3.1, ts_iso="T3")
    assert len(cleared) == 1
    assert cleared[0].state == "cleared"
    assert cleared[0].since == "T3"  # cleared timestamp, not the firing start


def test_cleared_incident_drops_after_retention() -> None:
    rule = AlertRule(topic="/cam", metric=AlertMetric.hz, op=AlertOp.lt, threshold=20.0)
    engine = AlertEngine([rule], clear_retain_s=5.0)
    assert engine.evaluate(_snapshot(5.0), now=0.0, ts_iso="T0")[0].state == "firing"
    # Recovers -> clears at once (clear_after_s=0) -> reported as cleared.
    assert engine.evaluate(_snapshot(30.0), now=1.0, ts_iso="T1")[0].state == "cleared"
    # Still within the 5s retention -> still reported (re-sent for reliable SSE).
    assert engine.evaluate(_snapshot(30.0), now=4.0, ts_iso="T2")[0].state == "cleared"
    # Past the retention window -> the incident drops entirely.
    assert engine.evaluate(_snapshot(30.0), now=7.0, ts_iso="T3") == []


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
    assert engine.evaluate(_snapshot(5.0), now=0.0, ts_iso="T0")[0].state == "firing"
    assert engine.evaluate(_snapshot(30.0), now=1.0, ts_iso="T1")[0].state == "cleared"
    # Condition true again at t=2, but within the 5s cooldown -> no re-fire (the
    # incident stays in its cleared state).
    assert engine.evaluate(_snapshot(5.0), now=2.0, ts_iso="T2")[0].state == "cleared"
    # After cooldown (t=7) it fires again.
    assert engine.evaluate(_snapshot(5.0), now=7.0, ts_iso="T3")[0].state == "firing"


def test_since_is_stable_across_consecutive_firing_ticks() -> None:
    rule = AlertRule(topic="/cam", metric=AlertMetric.hz, op=AlertOp.lt, threshold=20.0)
    engine = AlertEngine([rule])
    first = engine.evaluate(_snapshot(5.0), now=0.0, ts_iso="T0")
    second = engine.evaluate(_snapshot(6.0), now=1.0, ts_iso="T1")
    # The "since" timestamp is when it started firing, not the latest tick; the
    # value tracks the live reading so the UI can show it.
    assert first[0].since == "T0"
    assert second[0].since == "T0"
    assert second[0].value == 6.0


# --- default DANGER incident (D-9 ③) -------------------------------------


def test_default_danger_fires_after_sustained_status() -> None:
    engine = AlertEngine([], default_sustain_s=10.0)
    # DANGER for < sustain -> no incident yet.
    assert engine.evaluate(_danger(8.0), now=0.0, ts_iso="T0") == []
    assert engine.evaluate(_danger(8.0), now=5.0, ts_iso="T5") == []
    # DANGER sustained >= 10s -> a default hz incident fires. Threshold is the
    # rate reference (hz + deficit_per_s = 8 + 22 = 30); value is the live hz.
    fired = engine.evaluate(_danger(8.0), now=10.0, ts_iso="T10")
    assert len(fired) == 1
    assert fired[0].topic == "/cam"
    assert fired[0].metric == AlertMetric.hz
    assert fired[0].op == AlertOp.lt
    assert fired[0].threshold == 30.0
    assert fired[0].value == 8.0
    assert fired[0].state == "firing"


def test_default_danger_uses_static_expected_hz_when_available() -> None:
    engine = AlertEngine([], default_sustain_s=0.0, expected_hz_for=lambda _t: 25.0)
    fired = engine.evaluate(_danger(8.0), now=0.0, ts_iso="T0")
    assert fired[0].threshold == 25.0  # static expected_hz wins over reconstruction


def test_default_danger_clears_when_status_recovers() -> None:
    engine = AlertEngine([], default_sustain_s=0.0, clear_retain_s=5.0)
    assert engine.evaluate(_danger(8.0), now=0.0, ts_iso="T0")[0].state == "firing"
    # Status back to ok -> clears after the default clear hysteresis (3s).
    engine.evaluate(_danger(28.0, status="ok"), now=1.0, ts_iso="T1")
    cleared = engine.evaluate(_danger(28.0, status="ok"), now=4.0, ts_iso="T4")
    assert cleared[0].state == "cleared"


def test_config_rule_supersedes_default_danger() -> None:
    # A config (topic, hz) rule that does NOT trip must still suppress the default
    # incident for the same topic+metric (no double incident).
    rule = AlertRule(topic="/cam", metric=AlertMetric.hz, op=AlertOp.lt, threshold=5.0)
    engine = AlertEngine([rule], default_sustain_s=0.0)
    # hz=8 is not < 5 so the config rule stays quiet; the default is superseded.
    assert engine.evaluate(_danger(8.0), now=0.0, ts_iso="T0") == []
    assert engine.evaluate(_danger(8.0), now=10.0, ts_iso="T10") == []
