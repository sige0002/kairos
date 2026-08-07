"""Windowed metric math for topic_monitor (the unit-testable core).

This module computes per-topic monitoring metrics over sliding time windows from
nothing but :class:`~kairos_common.monitoring.subscriber.Sample` records (arrival time,
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
- **loss_rate**: ``None`` by default (true message loss is not generally
  computable in ROS 2 — no sequence numbers, and DDS sample-lost is the
  monitor's own subscription drop, not the publisher's/rosbag's).
- **rate_shortfall** / **deficit_per_s**: observed shortfall vs the *static*
  ``expected_hz`` over the window — ``max(0, 1 - count / (expected_hz*window))``
  and ``max(0, expected_hz - hz)``. This is **not** true loss: it folds the
  monitor's own best_effort drops, executor lag and a stopped publisher together
  (same condition as a naive count-vs-expected). Named so it never reads as
  rosbag loss. ``None`` without ``expected_hz``.
- **status** / **status_reason**: coarse per-topic health derived from
  rate_shortfall, with precedence ``inactive > danger > warning > ok >
  unknown``. ``inactive`` = silent (0 msgs); ``unknown`` = no ``expected_hz`` to
  judge against; ``danger``/``warning`` cross the shortfall thresholds; else ``ok``.

All times are seconds. ``recv_t`` is a monotonic clock; ``stamp_s`` is POSIX
wall-clock — the two are only subtracted when the caller provides both via the
same well-synchronised source, so stamp_delay is best-effort and may be ``None``.
"""

from __future__ import annotations

import statistics
import threading
from collections import deque
from dataclasses import dataclass, field, replace

from kairos_common.monitoring.subscriber import Sample

# Default observed-shortfall thresholds for the per-topic status (OL-②.2). A
# topic is "warning" once it drops >=2% under its expected rate over the window,
# "danger" at >=5%. These judge observed shortfall (module doc), not true loss.
DEFAULT_WARN_SHORTFALL = 0.02
DEFAULT_DANGER_SHORTFALL = 0.05

# Below this many *expected* messages per window, a percentage shortfall is not
# statistically meaningful (e.g. expected 5 msgs -> one missed = 20% "danger").
# Such low-rate topics are judged by an ABSOLUTE message deficit instead, which
# also absorbs most subscription warmup. Avoids false "danger" without needing
# cross-window state (hysteresis/EWMA is a later step — OL-②.3).
DEFAULT_MIN_STATUS_COUNT = 20.0
DEFAULT_WARN_ABS_DEFICIT = 2.0
DEFAULT_DANGER_ABS_DEFICIT = 3.0

# Status hysteresis (OL-②.3): a worse status must persist this long before the
# topic escalates (so one bad SSE tick / GC pause never paints a row red), and a
# better status must persist this long before it de-escalates. Time-based (not
# "N windows") so it is independent of how often compute()/snapshots are taken.
DEFAULT_STATUS_ESCALATE_S = 2.0
DEFAULT_STATUS_RECOVER_S = 1.0

# Status severity ranking, used by the hysteresis smoother. ``inactive`` (silent)
# and ``unknown`` (no expected_hz) are structural, not threshold noise, so the
# smoother adopts them immediately rather than waiting out a dwell.
_SEVERITY = {"unknown": 0, "ok": 1, "warning": 2, "danger": 3, "inactive": 4}
_STRUCTURAL = frozenset({"inactive", "unknown"})

# Dynamic baseline learning (OL-②.3): when a topic has NO static expected_hz,
# observe its windowed Hz for a warm-up period and, once steady (low coefficient
# of variation), adopt the mean as a learned shortfall reference. Mirrors the
# MonitorConfig defaults; the service overrides these from RECORDING_CONFIG.
DEFAULT_BASELINE_WARMUP_S = 10.0
DEFAULT_BASELINE_STABLE_CV = 0.15
DEFAULT_BASELINE_MIN_SAMPLES = 30

# Monitor self-load (OL-②.4): thresholds for the monitor's OWN processing health.
# A warning at the configured level, a danger at twice it (sustained overload).
DEFAULT_CALLBACK_LAG_WARN_MS = 50.0
DEFAULT_SNAPSHOT_AGE_WARN_S = 2.0
# How many recent sample-callback latencies to retain for mean/p95 (rolling).
DEFAULT_SELF_LOAD_CAPACITY = 1024


def _percentile(values: list[float], q: float) -> float | None:
    """Linear-interpolated q-th percentile (q in 0..100), or None if empty."""
    if not values:
        return None
    s = sorted(values)
    if len(s) == 1:
        return s[0]
    pos = (len(s) - 1) * (q / 100.0)
    lo = int(pos)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (pos - lo)


class StatusSmoother:
    """Time-based hysteresis over the raw per-window status (OL-②.3).

    Feed the instantaneous status each snapshot via :meth:`update`; it returns
    the smoothed status the UI should show. A more-severe raw status is only
    adopted after it has held for ``escalate_after_s``; a less-severe one after
    ``recover_after_s``. ``inactive`` / ``unknown`` are structural and adopted at
    once. Not thread-safe: call it from the single snapshot path.
    """

    def __init__(
        self,
        escalate_after_s: float = DEFAULT_STATUS_ESCALATE_S,
        recover_after_s: float = DEFAULT_STATUS_RECOVER_S,
        initial: str = "unknown",
    ) -> None:
        self._escalate_after_s = escalate_after_s
        self._recover_after_s = recover_after_s
        self._current = initial
        self._current_reason: str | None = None
        self._candidate: str | None = None
        self._since: float | None = None

    @property
    def current(self) -> str:
        return self._current

    @property
    def current_reason(self) -> str | None:
        """Reason of the currently-adopted status (kept in sync so it never
        contradicts a held status during a dwell transition)."""
        return self._current_reason

    def update(self, raw: str, now: float, reason: str | None = None) -> str:
        if raw in _STRUCTURAL or raw == self._current:
            # Adopt structural states at once; refresh the reason when the raw
            # status already matches the held one. Either way clear any candidate.
            self._current = raw
            self._current_reason = reason
            self._candidate = self._since = None
            return self._current
        if raw != self._candidate:
            self._candidate = raw
            self._since = now
        escalating = _SEVERITY[raw] > _SEVERITY[self._current]
        dwell = self._escalate_after_s if escalating else self._recover_after_s
        if self._since is not None and now - self._since >= dwell:
            self._current = raw
            self._current_reason = reason
            self._candidate = self._since = None
        return self._current


class BaselineLearner:
    """Learn an observed Hz baseline for a topic with no static expected_hz (OL-②.3).

    Fed one windowed-Hz value per snapshot via :meth:`update`. While warming up it
    reports ``state == "learning"`` and no baseline, so the caller keeps the topic
    ``unknown`` (never danger) during learning. Once it has observed for
    ``warmup_s``, collected at least ``min_samples`` values, and their coefficient
    of variation (population stddev / mean) is at/under ``stable_cv``, it declares
    ``state == "stable"`` and exposes ``baseline_hz`` (the running mean) as the
    shortfall reference. If a stable baseline later destabilises (CV rises above
    the threshold, or the topic falls silent) it flips to ``state == "unstable"``
    but keeps the last good baseline. Pure logic; not thread-safe — driven from
    the single snapshot path.
    """

    __slots__ = (
        "_warmup_s",
        "_stable_cv",
        "_min_samples",
        "_samples",
        "_first_t",
        "_state",
        "_baseline_hz",
    )

    def __init__(
        self,
        warmup_s: float = DEFAULT_BASELINE_WARMUP_S,
        stable_cv: float = DEFAULT_BASELINE_STABLE_CV,
        min_samples: int = DEFAULT_BASELINE_MIN_SAMPLES,
        capacity: int | None = None,
    ) -> None:
        self._warmup_s = warmup_s
        self._stable_cv = stable_cv
        self._min_samples = max(1, int(min_samples))
        # Retain enough recent samples to judge CV (and re-evaluate stability)
        # without unbounded growth; a small multiple of min_samples is plenty.
        cap = capacity if capacity is not None else max(self._min_samples * 4, 120)
        self._samples: deque[float] = deque(maxlen=cap)
        self._first_t: float | None = None
        self._state = "learning"
        self._baseline_hz: float | None = None

    @property
    def state(self) -> str:
        return self._state

    @property
    def baseline_hz(self) -> float | None:
        return self._baseline_hz

    def update(self, hz: float, now: float) -> tuple[str, float | None]:
        """Record a windowed-Hz observation; return ``(state, baseline_hz)``."""
        if self._first_t is None:
            self._first_t = now
        self._samples.append(max(0.0, hz))
        warmed = (
            now - self._first_t >= self._warmup_s
            and len(self._samples) >= self._min_samples
        )
        if not warmed:
            return self._state, self._baseline_hz
        mean = statistics.fmean(self._samples)
        if mean <= 0.0:
            # Silent over the window: cannot be a usable baseline. Demote a prior
            # good baseline to "unstable" (kept) but never claim a fresh one.
            if self._baseline_hz is not None:
                self._state = "unstable"
            return self._state, self._baseline_hz
        stdev = statistics.pstdev(self._samples) if len(self._samples) > 1 else 0.0
        cv = stdev / mean
        if cv <= self._stable_cv:
            # Adopt the mean as the baseline ONLY when (re)entering stable from a
            # non-stable state. Once stable, FREEZE it: a slow sustained decline
            # (10->8->6) would otherwise be tracked downward by the running mean
            # and never trip shortfall. It is only re-learned after an
            # unstable -> stable round-trip (a genuinely new steady rate).
            if self._state != "stable":
                self._baseline_hz = mean
            self._state = "stable"
        elif self._baseline_hz is not None:
            self._state = "unstable"  # had a baseline; keep the last good one
        # else: noisy and never stabilised -> stay "learning".
        return self._state, self._baseline_hz


@dataclass(slots=True)
class SelfLoadMetrics:
    """A point-in-time view of the monitor's OWN processing health (OL-②.4)."""

    callback_lag_ms: float | None
    callback_lag_p95_ms: float | None
    snapshot_age_s: float | None
    status: str


class SelfLoadMonitor:
    """Observe the monitor process's own load, separate from topic health (OL-②.4).

    Two real signals, never from decoding payloads:

    - **callback latency**: how long the registry takes to absorb each
      :class:`Sample` (``record_callback``) — mean + p95 over a rolling window.
    - **snapshot age**: how stale the freshest data the monitor holds is, derived
      from the most recent *receive* time across active topics (passed into
      ``build``), NOT from build timing — so it is independent of how many
      consumers (``GET /metrics`` + each SSE client) call the snapshot path.

    Thread-safe: ``record_callback`` runs on the subscriber thread while ``build``
    runs on the request/snapshot path.
    """

    def __init__(
        self,
        warn_lag_ms: float = DEFAULT_CALLBACK_LAG_WARN_MS,
        warn_age_s: float = DEFAULT_SNAPSHOT_AGE_WARN_S,
        capacity: int = DEFAULT_SELF_LOAD_CAPACITY,
    ) -> None:
        self._warn_lag_ms = warn_lag_ms
        self._warn_age_s = warn_age_s
        self._lags: deque[float] = deque(maxlen=capacity)
        self._lock = threading.Lock()

    def record_callback(self, lag_ms: float) -> None:
        """Record one sample-callback processing duration (milliseconds)."""
        with self._lock:
            self._lags.append(lag_ms if lag_ms > 0.0 else 0.0)

    def build(self, now: float, last_data_t: float | None) -> SelfLoadMetrics:
        """Aggregate the rolling latency window and the data-freshness age.

        ``last_data_t`` is the most recent monotonic receive time across active
        topics (``None`` if nothing has arrived yet); the age is ``now -
        last_data_t``. This is consumer-independent: calling ``build`` twice in a
        row yields the same age (it does not reset on each call).
        """
        with self._lock:
            lags = list(self._lags)
        age = None if last_data_t is None else max(0.0, now - last_data_t)
        mean = statistics.fmean(lags) if lags else None
        p95 = _percentile(lags, 95) if lags else None
        return SelfLoadMetrics(
            callback_lag_ms=mean,
            callback_lag_p95_ms=p95,
            snapshot_age_s=age,
            status=self._status(mean, age),
        )

    def _status(self, mean: float | None, age: float | None) -> str:
        sev = 0  # 0 ok, 1 warning, 2 danger
        if mean is not None:
            if mean >= 2.0 * self._warn_lag_ms:
                sev = max(sev, 2)
            elif mean >= self._warn_lag_ms:
                sev = max(sev, 1)
        if age is not None:
            if age >= 2.0 * self._warn_age_s:
                sev = max(sev, 2)
            elif age >= self._warn_age_s:
                sev = max(sev, 1)
        return ("ok", "warning", "danger")[sev]


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
    # Inter-arrival jitter from monotonic receive times (no decode): the honest
    # live "is it getting choppy" signal. p95 + max_gap precede a stall.
    interarrival_p50_ms: float | None = None
    interarrival_p95_ms: float | None = None
    # Observed shortfall vs static expected_hz (NOT true loss; see module doc).
    rate_shortfall: float | None = None
    deficit_per_s: float | None = None
    # Coarse health: "inactive" > "danger" > "warning" > "ok" > "unknown".
    status: str = "unknown"
    status_reason: str | None = None
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
        # rate_shortfall thresholds for the "warning"/"danger" status.
        warn_shortfall: float = DEFAULT_WARN_SHORTFALL,
        danger_shortfall: float = DEFAULT_DANGER_SHORTFALL,
        # Low-rate gate: judge by absolute deficit below this expected count.
        min_status_count: float = DEFAULT_MIN_STATUS_COUNT,
        warn_abs_deficit: float = DEFAULT_WARN_ABS_DEFICIT,
        danger_abs_deficit: float = DEFAULT_DANGER_ABS_DEFICIT,
    ) -> None:
        if not windows_s:
            raise ValueError("windows_s must be non-empty")
        self._windows_s = sorted(float(w) for w in windows_s)
        self._horizon = self._windows_s[-1]
        # Normalize a non-positive expected_hz to None: 0/negative is "no usable
        # expectation", not a real rate. Keeps every downstream divisor safe
        # (_health expected_count, _late expected_period) and statuses honest.
        self._expected_hz = (
            expected_hz if (expected_hz is None or expected_hz > 0) else None
        )
        self._late_tolerance = late_tolerance
        self._warn_shortfall = warn_shortfall
        self._danger_shortfall = danger_shortfall
        self._min_status_count = min_status_count
        self._warn_abs_deficit = warn_abs_deficit
        self._danger_abs_deficit = danger_abs_deficit
        self._obs: deque[_Obs] = deque()
        self._lock = threading.Lock()
        self._last_recv_t: float | None = None
        # Cumulative messages seen since subscribe (never evicted, unlike the
        # windowed deque). A start/stop delta yields a whole-window average rate.
        self._messages_total = 0

    @property
    def expected_hz(self) -> float | None:
        return self._expected_hz

    @property
    def messages_total(self) -> int:
        with self._lock:
            return self._messages_total

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
            self._messages_total += 1
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
            shortfall, deficit, status, status_reason = self._health(0, 0.0, window_s)
            return WindowMetrics(
                window_s=window_s,
                count=0,
                hz=0.0,
                bandwidth_bps=0.0,
                gap_max_ms=None,
                gap_exceed_count=0,
                inter_arrival_late_ratio=None,
                stamp_delay_ms=None,
                rate_shortfall=shortfall,
                deficit_per_s=deficit,
                status=status,
                status_reason=status_reason,
                late_reason=self._late_reason_when_empty(),
            )

        hz = count / window_s
        total_bytes = sum(o.size_bytes for o in window)
        bandwidth_bps = total_bytes / window_s

        gaps = [window[i].recv_t - window[i - 1].recv_t for i in range(1, len(window))]
        gap_max_ms = max(gaps) * 1000.0 if gaps else None
        p50 = _percentile(gaps, 50)
        p95 = _percentile(gaps, 95)

        late_ratio, exceed_count, late_reason = self._late(gaps)
        stamp_delay_ms = self._stamp_delay_ms(window)
        shortfall, deficit, status, status_reason = self._health(count, hz, window_s)

        return WindowMetrics(
            window_s=window_s,
            count=count,
            hz=hz,
            bandwidth_bps=bandwidth_bps,
            gap_max_ms=gap_max_ms,
            gap_exceed_count=exceed_count,
            inter_arrival_late_ratio=late_ratio,
            stamp_delay_ms=stamp_delay_ms,
            interarrival_p50_ms=p50 * 1000.0 if p50 is not None else None,
            interarrival_p95_ms=p95 * 1000.0 if p95 is not None else None,
            rate_shortfall=shortfall,
            deficit_per_s=deficit,
            status=status,
            status_reason=status_reason,
            late_reason=late_reason,
        )

    def health_with(self, wm: WindowMetrics, baseline_hz: float) -> WindowMetrics:
        """Recompute shortfall/status against a learned baseline (OL-②.3).

        Used only for topics with NO static expected_hz: the learned
        ``baseline_hz`` becomes the shortfall reference so the existing
        :meth:`_health` math applies unchanged. Static expected_hz always wins
        (returns ``wm`` untouched); a non-positive baseline is ignored.
        """
        if self._expected_hz is not None or baseline_hz <= 0.0:
            return wm
        shortfall, deficit, status, status_reason = self._health(
            wm.count, wm.hz or 0.0, wm.window_s, expected_override=baseline_hz
        )
        return replace(
            wm,
            rate_shortfall=shortfall,
            deficit_per_s=deficit,
            status=status,
            status_reason=status_reason,
        )

    def _health(
        self,
        count: int,
        hz: float,
        window_s: float,
        expected_override: float | None = None,
    ) -> tuple[float | None, float | None, str, str | None]:
        """Observed shortfall + coarse status (OL-②.1/②.2).

        Returns ``(rate_shortfall, deficit_per_s, status, status_reason)``.
        Precedence: ``inactive`` (silent) > ``danger`` > ``warning`` > ``ok`` >
        ``unknown`` (no expected_hz to judge against). The rate is observed
        shortfall vs the expected rate — never claimed as true loss.
        ``expected_override`` substitutes a learned baseline for the (absent)
        static expected_hz (OL-②.3); without it the static rate is used.
        """
        exp = self._expected_hz if expected_override is None else expected_override
        if count == 0:
            # A silent topic is observably inactive regardless of expected_hz.
            if exp is None:
                return None, None, "inactive", "no messages in window"
            return 1.0, exp, "inactive", f"silent: 0 of ~{exp:g} Hz expected"
        if exp is None:
            return None, None, "unknown", "no expected_hz"
        # expected_hz is normalized to >0 in __init__, so expected_count > 0.
        expected_count = exp * window_s
        shortfall = max(0.0, 1.0 - count / expected_count)
        deficit_rate = max(0.0, exp - hz)
        if expected_count < self._min_status_count:
            # Too few expected per window to trust a % shortfall: judge by the
            # absolute message deficit instead (avoids "1 of 5 missed = danger"
            # and most warmup false alarms). The numbers are still reported.
            deficit = expected_count - count
            if deficit >= self._danger_abs_deficit:
                return (
                    shortfall,
                    deficit_rate,
                    "danger",
                    f"{deficit:.0f}/{expected_count:.0f} msgs short",
                )
            if deficit >= self._warn_abs_deficit:
                return (
                    shortfall,
                    deficit_rate,
                    "warning",
                    f"{deficit:.0f}/{expected_count:.0f} msgs short",
                )
            return shortfall, deficit_rate, "ok", None
        if shortfall >= self._danger_shortfall:
            return (
                shortfall,
                deficit_rate,
                "danger",
                f"{shortfall * 100:.0f}% under {exp:g} Hz",
            )
        if shortfall >= self._warn_shortfall:
            return (
                shortfall,
                deficit_rate,
                "warning",
                f"{shortfall * 100:.0f}% under {exp:g} Hz",
            )
        return shortfall, deficit_rate, "ok", None

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
    # Cumulative DDS sample-lost count for this topic — the one honest "real loss"
    # signal available without sequence numbers (rmw message_lost event, no
    # decode). Fed by the subscriber via MetricsRegistry.on_sample_lost.
    dds_samples_lost: int = 0
    # Time-based status hysteresis (OL-②.3), applied in the snapshot path.
    status_smoother: StatusSmoother = field(default_factory=StatusSmoother)
    # Dynamic baseline learner (OL-②.3): present only when the topic has no static
    # expected_hz and baseline learning is enabled; otherwise None (static wins).
    baseline_learner: BaselineLearner | None = None


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
        warn_shortfall: float = DEFAULT_WARN_SHORTFALL,
        danger_shortfall: float = DEFAULT_DANGER_SHORTFALL,
        min_status_count: float = DEFAULT_MIN_STATUS_COUNT,
        escalate_after_s: float = DEFAULT_STATUS_ESCALATE_S,
        recover_after_s: float = DEFAULT_STATUS_RECOVER_S,
        baseline_learning: bool = True,
        baseline_warmup_s: float = DEFAULT_BASELINE_WARMUP_S,
        baseline_stable_cv: float = DEFAULT_BASELINE_STABLE_CV,
        baseline_min_samples: int = DEFAULT_BASELINE_MIN_SAMPLES,
    ) -> None:
        # expected_hz_for: callable(topic) -> float | None (first-match resolver).
        self._windows_s = [float(w) for w in windows_s]
        self._expected_hz_for = expected_hz_for
        self._late_tolerance = late_tolerance
        self._warn_shortfall = warn_shortfall
        self._danger_shortfall = danger_shortfall
        self._min_status_count = min_status_count
        self._escalate_after_s = escalate_after_s
        self._recover_after_s = recover_after_s
        self._baseline_learning = baseline_learning
        self._baseline_warmup_s = baseline_warmup_s
        self._baseline_stable_cv = baseline_stable_cv
        self._baseline_min_samples = baseline_min_samples
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
                expected = self._resolve_expected_hz(name)
                # Learn a baseline only when there's no static expected_hz (static
                # always wins) and learning is enabled (OL-②.3).
                learner = (
                    BaselineLearner(
                        self._baseline_warmup_s,
                        self._baseline_stable_cv,
                        self._baseline_min_samples,
                    )
                    if expected is None and self._baseline_learning
                    else None
                )
                state = TopicState(
                    name=name,
                    type=type_,
                    window=TopicWindow(
                        self._windows_s,
                        expected_hz=expected,
                        late_tolerance=self._late_tolerance,
                        warn_shortfall=self._warn_shortfall,
                        danger_shortfall=self._danger_shortfall,
                        min_status_count=self._min_status_count,
                    ),
                    qos=qos,
                    status_smoother=StatusSmoother(
                        self._escalate_after_s, self._recover_after_s
                    ),
                    baseline_learner=learner,
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

    def on_sample_lost(self, topic: str, count_change: int) -> None:
        """Accumulate DDS message_lost events for *topic* (rmw QoS event).

        The one honest "real loss" count available without sequence numbers or
        payload decode — distinct from rate_shortfall (which is observed
        throughput deficit). Negative/zero deltas are ignored.
        """
        if count_change <= 0:
            return
        state = self.ensure_topic(topic)
        with self._lock:
            state.dds_samples_lost += count_change

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
