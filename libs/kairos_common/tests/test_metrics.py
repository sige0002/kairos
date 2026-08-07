"""Windowed metric math: Hz / bandwidth / gap / late / stamp_delay from samples.

Drives :class:`~topic_monitor.metrics.TopicWindow` and
:class:`~topic_monitor.metrics.MetricsRegistry` with synthetic samples (no ROS)
and asserts the exact computed numbers.
"""

from __future__ import annotations

from kairos_common.monitoring.metrics import (
    BaselineLearner,
    MetricsRegistry,
    StatusSmoother,
    TopicWindow,
)
from kairos_common.monitoring.subscriber import Sample


def _sample(recv_t: float, size: int, stamp: float | None = None) -> Sample:
    return Sample(
        topic="/t",
        type="std_msgs/msg/String",
        recv_t=recv_t,
        size_bytes=size,
        stamp_s=stamp,
    )


def test_hz_and_bandwidth_over_window() -> None:
    win = TopicWindow(windows_s=[1.0, 5.0])
    # 5 messages, 1000 bytes each, at t = 0.0 .. 0.8 (all within a 5s window).
    for i in range(5):
        win.add(_sample(i * 0.2, 1000))
    m = win.compute(window_s=5.0, now=0.8)
    assert m.count == 5
    # 5 messages / 5 s window = 1.0 Hz.
    assert m.hz == 1.0
    # 5000 bytes / 5 s = 1000 bytes/s.
    assert m.bandwidth_bps == 1000.0


def test_hz_shorter_window_excludes_old_samples() -> None:
    win = TopicWindow(windows_s=[1.0, 5.0])
    # One old sample then a 30 Hz burst inside the last second.
    win.add(_sample(0.0, 100))
    times = [4.0 + i / 30.0 for i in range(30)]  # 30 msgs across ~1s ending at ~4.97
    for t in times:
        win.add(_sample(t, 100))
    m = win.compute(window_s=1.0, now=times[-1])
    # The old sample at t=0 is outside the 1s window; only the burst counts.
    assert m.count == 30
    assert abs(m.hz - 30.0) < 1e-9


def test_gap_max_ms_is_largest_interarrival() -> None:
    win = TopicWindow(windows_s=[5.0])
    for t in (0.0, 0.1, 0.5, 0.55):  # gaps: 100ms, 400ms, 50ms
        win.add(_sample(t, 10))
    m = win.compute(window_s=5.0, now=0.55)
    assert m.gap_max_ms is not None
    assert abs(m.gap_max_ms - 400.0) < 1e-6


def test_late_ratio_uses_expected_hz() -> None:
    # expected 10 Hz -> period 100ms, late threshold 150ms (tolerance 1.5).
    win = TopicWindow(windows_s=[5.0], expected_hz=10.0, late_tolerance=1.5)
    # gaps: 100ms (ok), 100ms (ok), 300ms (late), 100ms (ok) -> 1/4 late.
    for t in (0.0, 0.1, 0.2, 0.5, 0.6):
        win.add(_sample(t, 10))
    m = win.compute(window_s=5.0, now=0.6)
    assert m.gap_exceed_count == 1
    assert m.inter_arrival_late_ratio is not None
    assert abs(m.inter_arrival_late_ratio - 0.25) < 1e-9
    assert m.late_reason is None


def test_late_null_without_expected_hz() -> None:
    win = TopicWindow(windows_s=[5.0])  # no expected_hz
    for t in (0.0, 0.1, 0.2):
        win.add(_sample(t, 10))
    m = win.compute(window_s=5.0, now=0.2)
    assert m.inter_arrival_late_ratio is None
    assert m.late_reason == "no expected_hz"


def test_stamp_delay_is_median_of_positive_delays() -> None:
    win = TopicWindow(windows_s=[5.0])
    # recv - stamp delays: 0.010, 0.030, 0.020 s -> median 0.020 -> 20 ms.
    win.add(_sample(1.010, 10, stamp=1.000))
    win.add(_sample(2.030, 10, stamp=2.000))
    win.add(_sample(3.020, 10, stamp=3.000))
    m = win.compute(window_s=5.0, now=3.020)
    assert m.stamp_delay_ms is not None
    assert abs(m.stamp_delay_ms - 20.0) < 1e-6


def test_stamp_delay_ignores_negative_skew_and_none() -> None:
    win = TopicWindow(windows_s=[5.0])
    win.add(_sample(1.000, 10, stamp=1.050))  # negative delay -> ignored
    win.add(_sample(2.000, 10, stamp=None))  # no stamp -> ignored
    m = win.compute(window_s=5.0, now=2.0)
    assert m.stamp_delay_ms is None


def test_empty_window_reports_zero_hz() -> None:
    win = TopicWindow(windows_s=[1.0])
    m = win.compute(window_s=1.0, now=100.0)
    assert m.count == 0
    assert m.hz == 0.0
    assert m.bandwidth_bps == 0.0
    assert m.gap_max_ms is None


def test_shortfall_and_deficit_on_rate_is_ok() -> None:
    # expected 10 Hz over 5s -> 50 expected; deliver 50 -> 0 shortfall, ok.
    win = TopicWindow(windows_s=[5.0], expected_hz=10.0)
    for i in range(50):
        win.add(_sample(i * 0.1, 100))
    m = win.compute(window_s=5.0, now=4.9)
    assert m.rate_shortfall == 0.0
    assert m.deficit_per_s == 0.0
    assert m.status == "ok"
    assert m.status_reason is None


def test_shortfall_danger_when_half_rate() -> None:
    # expected 10 Hz over 5s -> 50 expected; deliver 25 -> 50% shortfall, danger.
    win = TopicWindow(windows_s=[5.0], expected_hz=10.0)
    for i in range(25):
        win.add(_sample(i * 0.2, 100))
    m = win.compute(window_s=5.0, now=4.8)
    assert m.rate_shortfall is not None
    assert abs(m.rate_shortfall - 0.5) < 1e-9
    assert m.deficit_per_s is not None
    assert abs(m.deficit_per_s - 5.0) < 1e-9  # 10 expected - 5 observed Hz
    assert m.status == "danger"
    assert "50%" in (m.status_reason or "")


def test_shortfall_warning_band() -> None:
    # 3% under expected (97 of 100) -> warning (>=2%, <5%).
    win = TopicWindow(windows_s=[10.0], expected_hz=10.0)
    for i in range(97):
        win.add(_sample(i * 0.1, 100))
    m = win.compute(window_s=10.0, now=9.7)
    assert m.status == "warning"
    assert m.rate_shortfall is not None and 0.02 <= m.rate_shortfall < 0.05


def test_status_unknown_without_expected_hz() -> None:
    win = TopicWindow(windows_s=[5.0])  # no expected_hz
    for t in (0.0, 0.1, 0.2):
        win.add(_sample(t, 10))
    m = win.compute(window_s=5.0, now=0.2)
    assert m.status == "unknown"
    assert m.rate_shortfall is None
    assert m.deficit_per_s is None
    assert m.status_reason == "no expected_hz"


def test_status_inactive_when_silent() -> None:
    # A silent topic is inactive even with an expected rate (reports full
    # observed shortfall, rate_shortfall == 1.0 — not a true-loss claim).
    win = TopicWindow(windows_s=[5.0], expected_hz=30.0)
    m = win.compute(window_s=5.0, now=100.0)
    assert m.count == 0
    assert m.status == "inactive"
    assert m.rate_shortfall == 1.0
    assert m.deficit_per_s == 30.0


def test_low_rate_topic_does_not_false_danger() -> None:
    # 1 Hz expected over 5 s -> 5 expected (< min_status_count). One missed
    # message (4 of 5, a 20% % shortfall) must NOT alarm — judged by absolute
    # deficit (1 < warn 2), so status stays "ok".
    win = TopicWindow(windows_s=[5.0], expected_hz=1.0)
    for t in (0.0, 1.0, 2.0, 3.0):
        win.add(_sample(t, 10))
    m = win.compute(window_s=5.0, now=4.99)
    assert m.count == 4
    assert m.rate_shortfall is not None and m.rate_shortfall > 0.15
    assert m.status == "ok"


def test_low_rate_topic_danger_on_large_absolute_deficit() -> None:
    # 1 Hz expected over 5 s -> 5 expected; only 2 arrive -> 3 short -> danger.
    win = TopicWindow(windows_s=[5.0], expected_hz=1.0)
    for t in (0.0, 1.0):
        win.add(_sample(t, 10))
    m = win.compute(window_s=5.0, now=4.99)
    assert m.count == 2
    assert m.status == "danger"


def test_non_positive_expected_hz_is_treated_as_none() -> None:
    win = TopicWindow(windows_s=[5.0], expected_hz=0.0)
    assert win.expected_hz is None
    for t in (0.0, 0.1, 0.2):
        win.add(_sample(t, 10))
    m = win.compute(window_s=5.0, now=0.2)
    # No usable expectation -> unknown, no shortfall numbers, no div-by-zero.
    assert m.status == "unknown"
    assert m.rate_shortfall is None
    assert m.inter_arrival_late_ratio is None


def test_interarrival_percentiles_uniform() -> None:
    win = TopicWindow(windows_s=[10.0])
    # 10 gaps of 100ms -> p50 and p95 are both 100ms.
    for i in range(11):
        win.add(_sample(i * 0.1, 10))
    m = win.compute(window_s=10.0, now=1.0)
    assert m.interarrival_p50_ms is not None
    assert abs(m.interarrival_p50_ms - 100.0) < 1e-6
    assert m.interarrival_p95_ms is not None
    assert abs(m.interarrival_p95_ms - 100.0) < 1e-6


def test_interarrival_p95_above_p50_on_skew() -> None:
    win = TopicWindow(windows_s=[20.0])
    t = 0.0
    win.add(_sample(t, 10))
    for _ in range(19):  # nineteen 50ms gaps
        t += 0.05
        win.add(_sample(t, 10))
    for _ in range(2):  # two 500ms gaps in the tail
        t += 0.5
        win.add(_sample(t, 10))
    m = win.compute(window_s=20.0, now=t)
    p50, p95 = m.interarrival_p50_ms, m.interarrival_p95_ms
    assert p50 is not None and abs(p50 - 50.0) < 1.0
    assert p95 is not None and abs(p95 - 500.0) < 1.0


def test_status_smoother_escalates_only_after_dwell() -> None:
    s = StatusSmoother(escalate_after_s=2.0, recover_after_s=1.0, initial="ok")
    assert s.update("danger", now=0.0) == "ok"  # one bad tick: not yet
    assert s.update("danger", now=1.0) == "ok"
    assert s.update("danger", now=2.0) == "danger"  # held the 2s dwell


def test_status_smoother_recovers_after_shorter_dwell() -> None:
    s = StatusSmoother(escalate_after_s=2.0, recover_after_s=1.0, initial="danger")
    assert s.update("ok", now=0.0) == "danger"
    assert s.update("ok", now=1.0) == "ok"  # recovery only needs 1s


def test_status_smoother_flap_restarts_dwell() -> None:
    s = StatusSmoother(escalate_after_s=2.0, recover_after_s=1.0, initial="ok")
    assert s.update("danger", now=0.0) == "ok"
    assert s.update("ok", now=0.5) == "ok"  # a good tick clears the candidate
    assert s.update("danger", now=1.0) == "ok"  # dwell restarts here
    assert s.update("danger", now=2.9) == "ok"
    assert s.update("danger", now=3.0) == "danger"


def test_status_smoother_structural_states_are_immediate() -> None:
    s = StatusSmoother(initial="ok")
    assert s.update("inactive", now=0.0) == "inactive"  # silent: adopt at once
    assert s.update("unknown", now=0.1) == "unknown"


# --- OL-②.3 dynamic baseline learning ------------------------------------


def test_baseline_learner_learns_until_warmed_then_stable() -> None:
    learner = BaselineLearner(warmup_s=10.0, stable_cv=0.15, min_samples=30)
    # Warm-up: under warmup_s AND under min_samples -> learning, no baseline.
    for i in range(20):  # now 0.0 .. 9.5 (< 10 s)
        state, base = learner.update(10.0, now=i * 0.5)
        assert state == "learning"
        assert base is None
    # Crossing both gates with a steady 10 Hz -> stable @ ~10 Hz.
    state, base = "learning", None
    for i in range(20, 30):  # now 10.0 .. 14.5, len reaches 30
        state, base = learner.update(10.0, now=i * 0.5)
    assert state == "stable"
    assert base is not None and abs(base - 10.0) < 1e-9


def test_baseline_learner_never_stabilises_on_noisy_rate() -> None:
    learner = BaselineLearner(warmup_s=0.0, stable_cv=0.1, min_samples=4)
    # High coefficient of variation -> stays "learning", never claims a baseline.
    for i, hz in enumerate([2.0, 20.0, 2.0, 20.0, 2.0, 20.0]):
        state, base = learner.update(hz, now=float(i))
    assert state == "learning"
    assert base is None


def test_baseline_learner_keeps_last_good_when_destabilised() -> None:
    learner = BaselineLearner(warmup_s=0.0, stable_cv=0.1, min_samples=3, capacity=4)
    for i in range(3):
        learner.update(10.0, now=float(i))
    assert learner.state == "stable"
    assert learner.baseline_hz == 10.0
    # Flood the small window with high-variance values: unstable, baseline kept.
    state, base = "stable", 10.0
    for i, hz in enumerate([2.0, 20.0, 2.0, 20.0, 2.0], start=3):
        state, base = learner.update(hz, now=float(i))
    assert state == "unstable"
    assert base == 10.0  # last good baseline retained


def test_baseline_frozen_once_stable_so_slow_decline_trips_shortfall() -> None:
    # Once stable, the baseline must NOT drift down with the running mean — a slow
    # sustained decline (10 -> 8 -> 6) that stays under the CV gate would otherwise
    # be tracked downward and never register as shortfall (MINOR-1).
    learner = BaselineLearner(warmup_s=0.0, stable_cv=0.5, min_samples=4, capacity=4)
    for _ in range(4):
        learner.update(10.0, now=0.0)
    assert learner.state == "stable"
    assert learner.baseline_hz == 10.0
    state, base = "stable", 10.0
    for hz, t in ((8.0, 1.0), (6.0, 2.0), (6.0, 3.0), (6.0, 4.0)):
        state, base = learner.update(hz, now=t)
    # Stayed stable (gentle decline, low CV) but the baseline is frozen at 10 — so
    # the observed 6 Hz now reads as a real shortfall vs the learned rate.
    assert state == "stable"
    assert base == 10.0


def test_baseline_relearns_after_unstable_round_trip() -> None:
    # The baseline is re-learned only after an unstable -> stable round-trip
    # (a genuinely new steady rate), not while continuously stable.
    learner = BaselineLearner(warmup_s=0.0, stable_cv=0.1, min_samples=3, capacity=3)
    for _ in range(3):
        learner.update(10.0, now=0.0)
    assert learner.state == "stable" and learner.baseline_hz == 10.0
    # Destabilise with a noisy burst.
    for hz in (2.0, 20.0, 2.0):
        learner.update(hz, now=1.0)
    assert learner.state == "unstable" and learner.baseline_hz == 10.0
    # Settle on a new steady rate -> re-stabilise -> adopt the new baseline.
    state, base = "unstable", 10.0
    for _ in range(3):
        state, base = learner.update(6.0, now=2.0)
    assert state == "stable"
    assert base is not None and abs(base - 6.0) < 1e-9


def test_baseline_learner_silent_demotes_but_keeps_baseline() -> None:
    learner = BaselineLearner(warmup_s=0.0, stable_cv=0.2, min_samples=3, capacity=4)
    for i in range(3):
        learner.update(10.0, now=float(i))
    assert learner.state == "stable" and learner.baseline_hz == 10.0
    # Window goes fully silent (mean 0) -> unstable, last good baseline kept.
    state, base = "stable", 10.0
    for i in range(3, 8):
        state, base = learner.update(0.0, now=float(i))
    assert state == "unstable"
    assert base == 10.0


def test_shortfall_uses_learned_baseline_when_no_static_expected() -> None:
    win = TopicWindow(windows_s=[5.0])  # no static expected_hz
    for i in range(25):  # 25 of 50 expected at a 10 Hz baseline over 5 s
        win.add(_sample(i * 0.2, 100))
    wm = win.compute(window_s=5.0, now=4.8)
    # Without a reference: unknown, no shortfall numbers.
    assert wm.status == "unknown"
    assert wm.rate_shortfall is None
    # Apply a learned baseline of 10 Hz -> 50% shortfall -> danger.
    wm2 = win.health_with(wm, baseline_hz=10.0)
    assert wm2.status == "danger"
    assert wm2.rate_shortfall is not None and abs(wm2.rate_shortfall - 0.5) < 1e-9
    assert wm2.deficit_per_s is not None and abs(wm2.deficit_per_s - 5.0) < 1e-9


def test_health_with_baseline_does_not_override_static_expected() -> None:
    win = TopicWindow(windows_s=[5.0], expected_hz=10.0)
    for i in range(50):
        win.add(_sample(i * 0.1, 100))
    wm = win.compute(window_s=5.0, now=4.9)
    assert wm.status == "ok"
    # A baseline must NOT override a configured expected_hz (static always wins).
    assert win.health_with(wm, baseline_hz=1.0) is wm


def test_health_with_non_positive_baseline_is_ignored() -> None:
    win = TopicWindow(windows_s=[5.0])
    for i in range(10):
        win.add(_sample(i * 0.2, 100))
    wm = win.compute(window_s=5.0, now=1.8)
    assert win.health_with(wm, baseline_hz=0.0) is wm


def test_on_sample_lost_accumulates_per_topic() -> None:
    reg = MetricsRegistry(windows_s=[1.0])
    reg.on_sample(Sample(topic="/t", type=None, recv_t=0.0, size_bytes=10))
    reg.on_sample_lost("/t", 3)
    reg.on_sample_lost("/t", 2)
    reg.on_sample_lost("/t", 0)  # ignored
    reg.on_sample_lost("/t", -1)  # ignored
    st = reg.get("/t")
    assert st is not None and st.dds_samples_lost == 5


def test_registry_routes_samples_and_resolves_expected_hz() -> None:
    def expected_hz_for(topic: str) -> float | None:
        return 30.0 if topic == "/cam" else None

    reg = MetricsRegistry(windows_s=[1.0], expected_hz_for=expected_hz_for)
    for t in (0.0, 0.033, 0.066):
        reg.on_sample(Sample(topic="/cam", type="img", recv_t=t, size_bytes=900))
    reg.on_sample(Sample(topic="/other", type=None, recv_t=0.0, size_bytes=10))

    cam = reg.get("/cam")
    other = reg.get("/other")
    assert cam is not None and other is not None
    assert cam.window.expected_hz == 30.0
    assert other.window.expected_hz is None
    assert {s.name for s in reg.topics()} == {"/cam", "/other"}
