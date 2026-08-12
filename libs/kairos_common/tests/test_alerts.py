# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Alert engine: incident firing + cooldown / clear_after hysteresis,
cleared-state retention, and the default DANGER incident (D-9 ③)."""

from __future__ import annotations

from kairos_common.monitoring.alerts import AlertEngine, metric_value
from kairos_common.monitoring.models import (
    AlertMetric,
    AlertOp,
    AlertRule,
    DerivedRulesConfig,
)


def _snapshot(hz: float | None) -> dict[str, dict[str, object]]:
    return {"/cam": {"name": "/cam", "hz": hz, "inter_arrival_late_ratio": None}}


def _hz(hz: float | None, *, status: str = "ok") -> dict[str, dict[str, object]]:
    """A one-topic snapshot for the derived-rule tests (engine resolves expected_hz)."""
    return {"/cam": {"name": "/cam", "hz": hz, "status": status}}


def _derived_engine(
    rules: list[AlertRule] | None = None,
    *,
    expected: float | None = 30.0,
    sustain_s: float = 0.0,
    clear_after_s: float = 0.0,
    cooldown_s: float = 0.0,
    default_sustain_s: float = 0.0,
) -> AlertEngine:
    return AlertEngine(
        rules or [],
        expected_hz_for=lambda _t: expected,
        derived_config=DerivedRulesConfig(
            sustain_s=sustain_s, clear_after_s=clear_after_s, cooldown_s=cooldown_s
        ),
        default_sustain_s=default_sustain_s,
    )


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


# --- auto-derived per-topic hz rules --------------------------------------


def test_derived_warning_fires_below_warn_ratio() -> None:
    # hz=20 is below 0.8*30=24 but above 0.5*30=15 -> a WARNING derived incident.
    engine = _derived_engine()
    fired = engine.evaluate(_hz(20.0), now=0.0, ts_iso="T0", now_ns=1)
    assert len(fired) == 1
    a = fired[0]
    assert a.topic == "/cam"
    assert a.metric == AlertMetric.hz
    assert a.state == "firing"
    assert a.rule_origin == "derived"
    assert a.severity == "warning"
    assert a.value == 20.0
    assert a.threshold == 24.0  # warn_ratio * expected


def test_derived_danger_fires_below_danger_ratio() -> None:
    # hz=10 is below 0.5*30=15 -> DANGER (deeper shortfall), threshold shown = 15.
    engine = _derived_engine()
    fired = engine.evaluate(_hz(10.0), now=0.0, ts_iso="T0", now_ns=1)
    assert fired[0].severity == "danger"
    assert fired[0].threshold == 15.0
    assert fired[0].rule_origin == "derived"


def test_derived_does_not_fire_when_on_rate() -> None:
    engine = _derived_engine()
    assert engine.evaluate(_hz(30.0), now=0.0, ts_iso="T0", now_ns=1) == []


def test_derived_respects_sustain() -> None:
    engine = _derived_engine(sustain_s=10.0)
    assert engine.evaluate(_hz(10.0), now=0.0, ts_iso="T0", now_ns=1) == []
    assert engine.evaluate(_hz(10.0), now=5.0, ts_iso="T5", now_ns=2) == []
    fired = engine.evaluate(_hz(10.0), now=10.0, ts_iso="T10", now_ns=3)
    assert fired and fired[0].state == "firing"


def test_explicit_config_rule_supersedes_derived() -> None:
    # A config (topic, hz) rule on /cam takes precedence: the derived mechanism
    # must not also raise an incident for the same topic+metric (with override).
    rule = AlertRule(topic="/cam", metric=AlertMetric.hz, op=AlertOp.lt, threshold=5.0)
    engine = _derived_engine([rule])
    # hz=10 would be a derived WARNING (< 24), but the config rule (lt 5) owns the
    # topic's hz and stays quiet at 10 -> no incident at all.
    assert engine.evaluate(_hz(10.0), now=0.0, ts_iso="T0", now_ns=1) == []


def test_no_duplicate_incident_derived_supersedes_default() -> None:
    # A topic with a static expected_hz AND status "danger" must raise exactly ONE
    # incident (the derived one), never a second from the default synthesizer.
    snap = {
        "/cam": {"name": "/cam", "hz": 10.0, "status": "danger", "deficit_per_s": 20.0}
    }
    engine = _derived_engine()
    fired = engine.evaluate(snap, now=0.0, ts_iso="T0", now_ns=1)
    assert len(fired) == 1
    assert fired[0].rule_origin == "derived"


def test_default_still_covers_topic_without_expected_hz() -> None:
    # A baseline-only topic (no static expected_hz) is NOT covered by derived, so
    # the status-based default synthesizer still fires for it.
    snap = {
        "/telem": {"name": "/telem", "hz": 5.0, "status": "danger", "baseline_hz": 20.0}
    }
    engine = _derived_engine(expected=None)
    fired = engine.evaluate(snap, now=0.0, ts_iso="T0", now_ns=1)
    assert len(fired) == 1
    assert fired[0].rule_origin == "default"
    assert fired[0].severity == "danger"


def test_derived_disabled_when_no_config_object() -> None:
    # Without a derived_config the feature is off (pre-feature behavior for units):
    # a topic with expected_hz + status danger falls to the default synthesizer.
    snap = {
        "/cam": {"name": "/cam", "hz": 10.0, "status": "danger", "deficit_per_s": 20.0}
    }
    engine = AlertEngine([], expected_hz_for=lambda _t: 30.0, default_sustain_s=0.0)
    fired = engine.evaluate(snap, now=0.0, ts_iso="T0", now_ns=1)
    assert len(fired) == 1
    assert fired[0].rule_origin == "default"


def test_derived_severity_escalates_in_history() -> None:
    # Warning first, then a deeper shortfall -> the SAME episode escalates to
    # danger in the history record (escalate-only, remembered on clear).
    engine = _derived_engine(cooldown_s=0.0)
    engine.evaluate(_hz(20.0), now=0.0, ts_iso="T0", now_ns=100)  # warning
    engine.evaluate(_hz(10.0), now=1.0, ts_iso="T1", now_ns=200)  # -> danger
    hist = engine.incident_history()
    assert len(hist) == 1
    assert hist[0].severity == "danger"
    assert hist[0].rule_origin == "derived"
    assert hist[0].cleared_at_ns is None


# --- incident history ring ------------------------------------------------


def test_incident_history_records_fire_and_clear_ns() -> None:
    engine = _derived_engine()
    engine.evaluate(_hz(10.0), now=0.0, ts_iso="T0", now_ns=100)  # fires (danger)
    engine.evaluate(_hz(30.0), now=1.0, ts_iso="T1", now_ns=200)  # recovers -> clears
    hist = engine.incident_history()
    assert len(hist) == 1
    inc = hist[0]
    assert inc.topic == "/cam"
    assert inc.metric == AlertMetric.hz
    assert inc.severity == "danger"
    assert inc.rule_origin == "derived"
    assert inc.fired_at_ns == 100
    assert inc.cleared_at_ns == 200
    assert inc.message  # a non-empty human-readable summary


def test_incident_history_since_filters_on_fired_or_cleared() -> None:
    engine = _derived_engine()
    engine.evaluate(_hz(10.0), now=0.0, ts_iso="T0", now_ns=100)  # fired_at_ns=100
    engine.evaluate(_hz(30.0), now=1.0, ts_iso="T1", now_ns=200)  # cleared_at_ns=200
    # since <= fired -> included via fired.
    assert len(engine.incident_history(since_ns=100)) == 1
    # since between fired and cleared -> included via cleared (matches OR clause).
    assert len(engine.incident_history(since_ns=150)) == 1
    # since after both -> excluded.
    assert engine.incident_history(since_ns=201) == []


def test_config_rule_incident_recorded_with_origin_and_severity() -> None:
    rule = AlertRule(
        topic="/cam",
        metric=AlertMetric.hz,
        op=AlertOp.lt,
        threshold=20.0,
        severity="danger",
    )
    engine = AlertEngine([rule])
    engine.evaluate(_snapshot(5.0), now=0.0, ts_iso="T0", now_ns=500)
    hist = engine.incident_history()
    assert len(hist) == 1
    assert hist[0].rule_origin == "config"
    assert hist[0].severity == "danger"
    assert hist[0].fired_at_ns == 500


def test_incident_history_ring_is_bounded() -> None:
    # 600 fire->clear episodes on one topic; the ring keeps only the last 500.
    engine = _derived_engine(cooldown_s=0.0)
    for i in range(600):
        engine.evaluate(_hz(10.0), now=2 * i, ts_iso=f"f{i}", now_ns=20 * i + 1)
        engine.evaluate(_hz(30.0), now=2 * i + 1, ts_iso=f"c{i}", now_ns=20 * i + 11)
    hist = engine.incident_history()
    assert len(hist) == 500  # bounded; the oldest 100 episodes were evicted
    # ids are unique per episode.
    assert len({inc.id for inc in hist}) == 500


def test_cooldown_refire_is_a_new_history_episode() -> None:
    engine = _derived_engine(cooldown_s=5.0)
    engine.evaluate(_hz(10.0), now=0.0, ts_iso="T0", now_ns=100)  # episode 1 fires
    engine.evaluate(_hz(30.0), now=1.0, ts_iso="T1", now_ns=200)  # clears
    # within cooldown -> no re-fire, still one episode.
    engine.evaluate(_hz(10.0), now=2.0, ts_iso="T2", now_ns=300)
    assert len(engine.incident_history()) == 1
    # after cooldown -> a fresh episode (new id, new fired_at_ns).
    engine.evaluate(_hz(10.0), now=7.0, ts_iso="T3", now_ns=700)
    hist = engine.incident_history()
    assert len(hist) == 2
    assert hist[0].id != hist[1].id
    assert hist[1].fired_at_ns == 700
