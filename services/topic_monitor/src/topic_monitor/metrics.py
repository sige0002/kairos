"""Windowed metric math for topic_monitor (the unit-testable core).

This module computes per-topic monitoring metrics over sliding time windows from
nothing but :class:`~topic_monitor.subscriber.Sample` records (arrival time,
serialized size, optional ``header.stamp``). It has **no ROS dependency**: feed
it synthetic ``(recv_t, size)`` sequences and assert on the numbers.

Metric definitions (see ``docs/specs/ja/topic_monitor.md``):

- **hz**: messages in the window / window length.
- **bandwidth_bps**: serialized bytes in the window / window length.
- **gap_max_ms**: largest inter-arrival gap in the window.
- **gap_exceed_count** / **inter_arrival_late_ratio**: gaps exceeding the
  expected inter-arrival period (from ``expected_hz``). The ratio is
  late-intervals / total-intervals in the window. Both require ``expected_hz``.
- **stamp_delay_ms**: median (recv_t - header.stamp), only over samples that
  carried a usable stamp. ``None`` when no stamped samples are in the window.
- **loss_rate**: ``None`` by default (not generally computable in ROS 2).

All times are seconds. ``recv_t`` is a monotonic clock; ``stamp_s`` is POSIX
wall-clock — the two are only subtracted when the caller provides both via the
same well-synchronised source, so stamp_delay is best-effort and may be ``None``.
"""

from __future__ import annotations

import statistics
import threading
from collections import deque
from dataclasses import dataclass, field

from topic_monitor.subscriber import Sample


@dataclass(slots=True)
class _Obs:
    """A retained observation within the window horizon."""

    recv_t: float
    size_bytes: int
    stamp_delay_s: float | None


@dataclass(slots=True)
class WindowMetrics:
    """Computed metrics for one topic over one window length."""

    window_s: float
    count: int
    hz: float | None
    bandwidth_bps: float | None
    gap_max_ms: float | None
    gap_exceed_count: int
    inter_arrival_late_ratio: float | None
    stamp_delay_ms: float | None
    # Reason Late metrics are null (only set when they are).
    late_reason: str | None = None


class TopicWindow:
    """Sliding-window metric accumulator for a single topic.

    Retains observations for the largest configured window and computes metrics
    for any requested window length on demand. Thread-safe: :meth:`add` is called
    from the subscriber thread while :meth:`compute` is called from the request
    thread.
    """

    def __init__(
        self,
        windows_s: list[float],
        expected_hz: float | None = None,
        # A gap counts as "late" once it exceeds expected_period * this factor.
        late_tolerance: float = 1.5,
    ) -> None:
        if not windows_s:
            raise ValueError("windows_s must be non-empty")
        self._windows_s = sorted(float(w) for w in windows_s)
        self._horizon = self._windows_s[-1]
        self._expected_hz = expected_hz
        self._late_tolerance = late_tolerance
        self._obs: deque[_Obs] = deque()
        self._lock = threading.Lock()
        self._last_recv_t: float | None = None

    @property
    def expected_hz(self) -> float | None:
        return self._expected_hz

    def add(self, sample: Sample) -> None:
        """Record a sample (called per received message)."""
        stamp_delay = None
        if sample.stamp_s is not None:
            delay = sample.recv_t - sample.stamp_s
            # Negative delays mean clock skew (stamp ahead of arrival); ignore
            # them rather than report a misleading negative "delay".
            stamp_delay = delay if delay >= 0 else None
        with self._lock:
            self._obs.append(
                _Obs(
                    recv_t=sample.recv_t,
                    size_bytes=sample.size_bytes,
                    stamp_delay_s=stamp_delay,
                )
            )
            self._last_recv_t = sample.recv_t
            self._evict(sample.recv_t)

    def _evict(self, now: float) -> None:
        """Drop observations older than the largest window horizon."""
        cutoff = now - self._horizon
        obs = self._obs
        while obs and obs[0].recv_t < cutoff:
            obs.popleft()

    def last_recv_t(self) -> float | None:
        with self._lock:
            return self._last_recv_t

    def compute(self, window_s: float, now: float) -> WindowMetrics:
        """Compute metrics for *window_s* as of monotonic time *now*."""
        with self._lock:
            self._evict(now)
            window = [o for o in self._obs if o.recv_t >= now - window_s]
        return self._compute_from(window, window_s)

    def _compute_from(self, window: list[_Obs], window_s: float) -> WindowMetrics:
        count = len(window)
        if count == 0:
            return WindowMetrics(
                window_s=window_s,
                count=0,
                hz=0.0,
                bandwidth_bps=0.0,
                gap_max_ms=None,
                gap_exceed_count=0,
                inter_arrival_late_ratio=None,
                stamp_delay_ms=None,
                late_reason=self._late_reason_when_empty(),
            )

        hz = count / window_s
        total_bytes = sum(o.size_bytes for o in window)
        bandwidth_bps = total_bytes / window_s

        gaps = [window[i].recv_t - window[i - 1].recv_t for i in range(1, len(window))]
        gap_max_ms = max(gaps) * 1000.0 if gaps else None

        late_ratio, exceed_count, late_reason = self._late(gaps)
        stamp_delay_ms = self._stamp_delay_ms(window)

        return WindowMetrics(
            window_s=window_s,
            count=count,
            hz=hz,
            bandwidth_bps=bandwidth_bps,
            gap_max_ms=gap_max_ms,
            gap_exceed_count=exceed_count,
            inter_arrival_late_ratio=late_ratio,
            stamp_delay_ms=stamp_delay_ms,
            late_reason=late_reason,
        )

    def _late(self, gaps: list[float]) -> tuple[float | None, int, str | None]:
        """Late split from inter-arrival gaps vs the expected period."""
        if self._expected_hz is None:
            return None, 0, "no expected_hz"
        expected_period = 1.0 / self._expected_hz
        threshold = expected_period * self._late_tolerance
        exceed = sum(1 for g in gaps if g > threshold)
        if not gaps:
            # A single sample in the window: no interval to judge lateness on.
            return None, 0, "insufficient samples"
        return exceed / len(gaps), exceed, None

    @staticmethod
    def _stamp_delay_ms(window: list[_Obs]) -> float | None:
        """Median stamp delay (ms) over samples that carried a usable stamp."""
        delays = [o.stamp_delay_s for o in window if o.stamp_delay_s is not None]
        if not delays:
            return None
        return statistics.median(delays) * 1000.0

    def _late_reason_when_empty(self) -> str | None:
        return "no expected_hz" if self._expected_hz is None else "no samples"


@dataclass
class TopicState:
    """Per-topic monitoring state held by the registry."""

    name: str
    type: str | None
    window: TopicWindow
    qos: object | None = None  # QosInfo; kept opaque to avoid a model import here
    last_seen_t: float | None = None
    sensor_preview: dict[str, object] | None = field(default=None)


class MetricsRegistry:
    """Holds a :class:`TopicWindow` per monitored topic and feeds samples in.

    The single sink the subscriber pushes every :class:`Sample` to. Topics are
    created lazily on first sample (within the allowlist the subscriber already
    enforces) but seeded from the allowlist so a silent topic still reports 0 Hz.
    Thread-safe.
    """

    def __init__(
        self,
        windows_s: list[float],
        expected_hz_for: object | None = None,
        late_tolerance: float = 1.5,
    ) -> None:
        # expected_hz_for: callable(topic) -> float | None (first-match resolver).
        self._windows_s = [float(w) for w in windows_s]
        self._expected_hz_for = expected_hz_for
        self._late_tolerance = late_tolerance
        self._topics: dict[str, TopicState] = {}
        self._lock = threading.Lock()

    @property
    def windows_s(self) -> list[float]:
        return list(self._windows_s)

    def _resolve_expected_hz(self, topic: str) -> float | None:
        if self._expected_hz_for is None:
            return None
        return self._expected_hz_for(topic)  # type: ignore[operator]

    def ensure_topic(
        self, name: str, type_: str | None = None, qos: object | None = None
    ) -> TopicState:
        """Create (or fetch) the state for *name*, seeding its window."""
        with self._lock:
            state = self._topics.get(name)
            if state is None:
                state = TopicState(
                    name=name,
                    type=type_,
                    window=TopicWindow(
                        self._windows_s,
                        expected_hz=self._resolve_expected_hz(name),
                        late_tolerance=self._late_tolerance,
                    ),
                    qos=qos,
                )
                self._topics[name] = state
            else:
                # Backfill type/qos discovered later.
                if state.type is None and type_ is not None:
                    state.type = type_
                if state.qos is None and qos is not None:
                    state.qos = qos
            return state

    def on_sample(self, sample: Sample) -> None:
        """Sink for the subscriber: route a sample into its topic window."""
        state = self.ensure_topic(sample.topic, sample.type)
        state.window.add(sample)
        state.last_seen_t = sample.recv_t

    def set_sensor_preview(self, topic: str, preview: dict[str, object] | None) -> None:
        """Attach the latest decoded sensor preview for *topic* (if enabled)."""
        with self._lock:
            state = self._topics.get(topic)
            if state is not None:
                state.sensor_preview = preview

    def topics(self) -> list[TopicState]:
        with self._lock:
            return list(self._topics.values())

    def get(self, name: str) -> TopicState | None:
        with self._lock:
            return self._topics.get(name)
