"""Windowed metric math: Hz / bandwidth / gap / late / stamp_delay from samples.

Drives :class:`~topic_monitor.metrics.TopicWindow` and
:class:`~topic_monitor.metrics.MetricsRegistry` with synthetic samples (no ROS)
and asserts the exact computed numbers.
"""

from __future__ import annotations

from topic_monitor.metrics import MetricsRegistry, TopicWindow
from topic_monitor.subscriber import Sample


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
