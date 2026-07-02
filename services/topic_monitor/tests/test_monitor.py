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
from topic_monitor.metrics import SelfLoadMonitor
from topic_monitor.models import AlertMetric, AlertOp, AlertRule
from topic_monitor.monitor import MonitorService
from topic_monitor.subscriber import FakeSubscriber, TopicGraphEntry


class FakeClock:
    """A manually-advanced monotonic clock for deterministic windows."""

    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t


class StepPerf:
    """A perf clock that advances a fixed step per call (deterministic lag).

    ``_on_sample`` calls it twice per sample (before/after the registry), so a
    constant *step* makes each measured callback latency exactly *step* seconds.
    """

    def __init__(self, step: float = 0.002) -> None:
        self.t = 0.0
        self.step = step

    def __call__(self) -> float:
        v = self.t
        self.t += self.step
        return v


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


# --- OL-②.4 monitor self-load metrics ------------------------------------


def test_self_load_aggregates_mean_and_p95() -> None:
    sl = SelfLoadMonitor(warn_lag_ms=50.0, warn_age_s=2.0)
    for v in (10.0, 10.0, 10.0, 100.0):
        sl.record_callback(v)
    m = sl.build(now=0.0, last_data_t=None)
    assert m.callback_lag_ms is not None and abs(m.callback_lag_ms - 32.5) < 1e-9
    assert m.callback_lag_p95_ms is not None and m.callback_lag_p95_ms > 50.0
    assert m.snapshot_age_s is None  # no data received yet
    assert m.status == "ok"  # mean 32.5 ms < 50 ms warn


def test_self_load_status_warning_then_danger_on_lag() -> None:
    warn = SelfLoadMonitor(warn_lag_ms=50.0, warn_age_s=2.0)
    warn.record_callback(60.0)  # >= warn, < 2x
    assert warn.build(now=0.0, last_data_t=0.0).status == "warning"

    danger = SelfLoadMonitor(warn_lag_ms=50.0, warn_age_s=2.0)
    danger.record_callback(150.0)  # >= 2x warn
    assert danger.build(now=0.0, last_data_t=0.0).status == "danger"


def test_self_load_age_is_data_freshness_and_consumer_independent() -> None:
    # Age is `now - last_data_t` (most recent receive time), NOT build timing —
    # so multiple consumers calling build() do not dilute or reset it.
    sl = SelfLoadMonitor(warn_lag_ms=50.0, warn_age_s=2.0)
    sl.record_callback(1.0)
    # Data last arrived at t=10; serving at t=10 -> fresh (age 0).
    assert sl.build(now=10.0, last_data_t=10.0).snapshot_age_s == 0.0
    # Two builds in a row at the same now/data give the SAME age (no reset).
    a = sl.build(now=13.0, last_data_t=10.0)
    b = sl.build(now=13.0, last_data_t=10.0)
    assert a.snapshot_age_s == b.snapshot_age_s == 3.0
    assert a.status == "warning"  # 3 s >= warn 2 s, < 4 s danger
    # No data yet -> age unknown.
    assert sl.build(now=5.0, last_data_t=None).snapshot_age_s is None


def test_snapshot_includes_self_load_by_default() -> None:
    clock = FakeClock()
    perf = StepPerf(step=0.002)  # 2 ms per callback
    sub = FakeSubscriber()
    service = MonitorService(sub, config=_config(), clock=clock, perf_clock=perf)
    service.start()
    for i in range(10):
        clock.t = i * 0.1
        sub.feed("/cam", recv_t=clock.t, size_bytes=100)
    snap = service.metrics_snapshot()
    assert snap.self_load is not None
    assert snap.self_load.callback_lag_ms is not None
    assert abs(snap.self_load.callback_lag_ms - 2.0) < 1e-6  # 2 ms steps
    assert snap.self_load.status == "ok"


def test_self_load_age_independent_of_consumer_count() -> None:
    # Two snapshots in a row (mimicking GET /metrics + an SSE tick) must report
    # the SAME data-freshness age — the old build-timing age would have reset the
    # second one to ~0 (MAJOR-3).
    clock = FakeClock()
    sub = FakeSubscriber()
    service = MonitorService(sub, config=_config(), clock=clock)
    service.start()
    clock.t = 1.0
    sub.feed("/cam", recv_t=1.0, size_bytes=100)
    clock.t = 4.0  # 3 s since the last sample arrived
    a = service.metrics_snapshot().self_load
    b = service.metrics_snapshot().self_load
    assert a is not None and b is not None
    assert a.snapshot_age_s is not None and abs(a.snapshot_age_s - 3.0) < 1e-9
    assert b.snapshot_age_s == a.snapshot_age_s  # second call did not reset it


def test_self_load_can_be_disabled_via_config() -> None:
    cfg = _config()
    cfg.monitor.self_load_metrics = False
    service = MonitorService(FakeSubscriber(), config=cfg)
    service.start()
    assert service.metrics_snapshot().self_load is None


# --- OL-②.3 dynamic baseline learning (end-to-end via the snapshot path) --


def test_baseline_learning_for_unconfigured_topic_warmup_then_judges() -> None:
    clock = FakeClock()
    sub = FakeSubscriber()
    cfg = RecordingConfig(robot_name="r", default_topics=[])
    cfg.monitor.window_s = [5]
    cfg.monitor.baseline_warmup_s = 3.0
    cfg.monitor.baseline_min_samples = 10
    cfg.monitor.baseline_stable_cv = 0.2
    service = MonitorService(sub, config=cfg, clock=clock)
    service.start()
    topic = "/telemetry"  # no expected_hz pattern -> baseline-learned

    def t_of(step: int) -> float:
        return round(step * 0.1, 5)

    # Phase A: fill the 5 s window at 10 Hz (no snapshots yet).
    step = 0
    while t_of(step) < 5.0:
        clock.t = t_of(step)
        sub.feed(topic, recv_t=clock.t, size_bytes=100)
        step += 1

    # Phase B: keep feeding 10 Hz, snapshot ~every 0.3 s to drive the learner.
    learning_rows = []
    final_row = None
    while t_of(step) <= 14.0:
        clock.t = t_of(step)
        sub.feed(topic, recv_t=clock.t, size_bytes=100)
        if step % 3 == 0:
            snap = service.metrics_snapshot()
            row = next((x for x in snap.topics if x.name == topic), None)
            if row is not None:
                if clock.t < 7.0:
                    learning_rows.append(row)
                final_row = row
        step += 1

    # During warm-up: state "learning", status held "unknown" (never danger).
    assert learning_rows
    assert all(r.baseline_state == "learning" for r in learning_rows)
    assert all(r.status == "unknown" for r in learning_rows)
    assert all(r.baseline_hz is None for r in learning_rows)
    # Once warmed on a steady rate: stable baseline ~10 Hz, judged on its own rate.
    assert final_row is not None
    assert final_row.baseline_state == "stable"
    assert final_row.baseline_hz is not None and abs(final_row.baseline_hz - 10.0) < 1.5
    assert final_row.status == "ok"


def test_is_ready_reflects_subscriber_liveness() -> None:
    sub = FakeSubscriber()
    service = MonitorService(sub, config=_config())
    assert service.is_ready() is False
    service.start()
    assert service.is_ready() is True
    service.stop()
    assert service.is_ready() is False


# --- MON-M2 shared short-TTL snapshot cache -------------------------------


def test_snapshot_cached_within_ttl_and_shared_across_consumers() -> None:
    # Two snapshot reads at the SAME tick (mimicking GET /metrics + an SSE tick +
    # /alerts) must return the SAME cached object — the heavy build runs once.
    clock = FakeClock()
    sub = FakeSubscriber()
    service = MonitorService(sub, config=_config(), clock=clock)
    service.start()
    clock.t = 1.0
    sub.feed("/cam", recv_t=1.0, size_bytes=100)

    first = service.metrics_snapshot()
    second = service.metrics_snapshot()
    assert first is second  # cached within the TTL, not recomputed
    # /alerts shares the same cache (same object identity for the alert list).
    assert service.alerts() is first.alerts

    # Advancing past the TTL forces a fresh build (new object).
    clock.t = 1.0 + 0.5  # > _SNAPSHOT_TTL_S
    third = service.metrics_snapshot()
    assert third is not first


def test_baseline_learner_advances_once_per_tick_not_per_consumer() -> None:
    # MON-M1: the baseline learner warms on ticks, not consumer count. Two
    # snapshots per tick must feed it ONE observation (the second is cached).
    clock = FakeClock()
    sub = FakeSubscriber()
    cfg = RecordingConfig(robot_name="r", default_topics=[])
    cfg.monitor.window_s = [5]
    service = MonitorService(sub, config=cfg, clock=clock)
    service.start()
    topic = "/telemetry"  # no expected_hz -> baseline-learned

    ticks = 3
    for i in range(1, ticks + 1):
        clock.t = round(i * 0.5, 5)  # 0.5 s apart > TTL -> each first call rebuilds
        sub.feed(topic, recv_t=clock.t, size_bytes=100)
        service.metrics_snapshot()
        service.metrics_snapshot()  # same tick -> cached, no extra learner update

    state = service._registry.get(topic)
    assert state is not None and state.baseline_learner is not None
    # One learner observation per DISTINCT tick (3), not per snapshot call (6).
    assert len(state.baseline_learner._samples) == ticks


# --- MON-M4 allowlist match diagnostics -----------------------------------


def test_allowlist_diag_reports_total_and_matched() -> None:
    clock = FakeClock()
    sub = FakeSubscriber()
    # _config() allowlist = ["/cam", "/joint_states"].
    service = MonitorService(sub, config=_config(), clock=clock)
    service.start()

    # Seeded but silent: total=2, matched=0 (nothing has produced data yet). This
    # is the "allowlist matches nothing live" signal for an empty-looking Monitor.
    snap = service.metrics_snapshot()
    assert snap.allowlist_total == 2
    assert snap.allowlist_matched == 0

    # Feed /cam -> one allowlist pattern now matches a data-producing topic.
    clock.t = 1.0
    sub.feed("/cam", recv_t=1.0, size_bytes=100)
    snap = service.metrics_snapshot()
    assert snap.allowlist_total == 2
    assert snap.allowlist_matched == 1


def test_allowlist_diag_zero_without_config() -> None:
    service = MonitorService(FakeSubscriber())  # no config -> no allowlist
    service.start()
    snap = service.metrics_snapshot()
    assert snap.allowlist_total == 0
    assert snap.allowlist_matched == 0


def test_allowlist_diag_matched_bounded_by_total_with_globs() -> None:
    clock = FakeClock()
    sub = FakeSubscriber()
    cfg = RecordingConfig(robot_name="r", default_topics=["/hsrb/*"])
    cfg.monitor.window_s = [5]
    service = MonitorService(sub, config=cfg, clock=clock)
    service.start()
    # Two distinct topics match the single glob pattern.
    clock.t = 0.5
    sub.feed("/hsrb/odom", recv_t=0.5, size_bytes=100)
    sub.feed("/hsrb/joint_states", recv_t=0.5, size_bytes=100)
    snap = service.metrics_snapshot()
    # Pattern-centric: the one glob counts once -> matched <= total.
    assert snap.allowlist_total == 1
    assert snap.allowlist_matched == 1
