# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""The monitoring service: subscriber -> registry -> snapshot (ROS-free core).

:class:`MonitorService` is the heart of topic_monitor. It owns a
:class:`~kairos_common.monitoring.subscriber.TopicSubscriber` (the ROS seam), wires its
samples into the :class:`~kairos_common.monitoring.metrics.MetricsRegistry`, and
turns the
accumulated windows into the API response models (``MetricsSnapshot`` /
``TopicsResponse`` / ``AlertsResponse``). Pause/resume forward to the subscriber.

It depends only on the :class:`TopicSubscriber` Protocol, never on rclpy, so the
full path — sample in, snapshot out, alerts evaluated — is unit-testable by
injecting a :class:`~kairos_common.monitoring.subscriber.FakeSubscriber` and feeding
synthetic samples. ``main.py`` injects the real rclpy-backed subscriber instead.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from fnmatch import fnmatch

from kairos_common import RecordingConfig, utc_now_iso8601
from kairos_common.monitoring.alerts import AlertEngine
from kairos_common.monitoring.expected_hz import make_expected_hz_resolver
from kairos_common.monitoring.metrics import (
    MetricsRegistry,
    SelfLoadMonitor,
    TopicState,
)
from kairos_common.monitoring.models import (
    Alert,
    AlertRule,
    DerivedRulesConfig,
    Incident,
    MetricsSnapshot,
    MonitorSelfLoad,
    QosInfo,
    TopicInfo,
    TopicMetrics,
    TopicsResponse,
)
from kairos_common.monitoring.subscriber import Sample, TopicSubscriber

# Default sliding windows if the RECORDING_CONFIG monitor block is unavailable.
_DEFAULT_WINDOWS_S: list[float] = [1.0, 5.0]

# Snapshot cache TTL (seconds). Within one tick many consumers may ask for the
# snapshot at once — GET /metrics, both SSE streams (/metrics/stream +
# /alerts/stream) and /alerts — and recomputing per consumer is CPU linear in
# consumer count (MON-M2), against the "lightweight first" goal. A short shared
# TTL makes the heavy build run about once per tick; it also advances the alert
# hysteresis and the baseline learner once per tick rather than once per consumer
# (MON-M1), so warm-up no longer depends on how many consumers poll.
_SNAPSHOT_TTL_S = 0.25


class MonitorService:
    """Coordinates the subscriber, metric registry, and alert engine.

    A single instance is created per process and shared by the FastAPI routes.
    The subscriber pushes every :class:`Sample` to :meth:`_on_sample`, which the
    registry routes into per-topic windows; the request thread reads consistent
    snapshots via :meth:`metrics_snapshot` / :meth:`topics`.
    """

    def __init__(
        self,
        subscriber: TopicSubscriber,
        *,
        config: RecordingConfig | None = None,
        alert_rules: list[AlertRule] | None = None,
        derived_config: DerivedRulesConfig | None = None,
        clock: Callable[[], float] = time.monotonic,
        perf_clock: Callable[[], float] = time.perf_counter,
        wall_clock_ns: Callable[[], int] = time.time_ns,
    ) -> None:
        self._subscriber = subscriber
        self._config = config
        self._clock = clock
        self._perf = perf_clock
        self._wall_clock_ns = wall_clock_ns
        self._lock = threading.Lock()
        self._paused = False
        # Shared short-TTL snapshot cache (MON-M2/M1); see _SNAPSHOT_TTL_S.
        self._snapshot_lock = threading.Lock()
        self._cached_snapshot: MetricsSnapshot | None = None
        self._cached_at: float | None = None
        # Allowlist patterns (RECORDING_CONFIG default_topics) for the /metrics
        # diagnostics (MON-M4); empty when there is no config.
        self._allowlist = list(config.default_topics) if config is not None else []

        windows = self._resolve_windows(config)
        # The snapshot window is the largest configured (gives the most stable
        # rate); shorter windows stay available in the registry for future use.
        self._snapshot_window_s = windows[-1]
        # Status thresholds + hysteresis + baseline learning come from the
        # RECORDING_CONFIG monitor block (config-driven, not hardcoded); the
        # registry defaults apply when there is no config.
        reg_kwargs: dict[str, float | bool | int] = {}
        if config is not None:
            m = config.monitor
            reg_kwargs = {
                "warn_shortfall": m.warn_shortfall,
                "danger_shortfall": m.danger_shortfall,
                "min_status_count": m.min_status_count,
                "escalate_after_s": m.status_escalate_s,
                "recover_after_s": m.status_recover_s,
                "baseline_learning": m.baseline_learning,
                "baseline_warmup_s": m.baseline_warmup_s,
                "baseline_stable_cv": m.baseline_stable_cv,
                "baseline_min_samples": m.baseline_min_samples,
            }
        self._registry = MetricsRegistry(
            windows,
            expected_hz_for=make_expected_hz_resolver(config),
            **reg_kwargs,
        )
        # The alert engine also synthesizes derived per-topic hz incidents (from
        # expected_hz shortfall) and default DANGER incidents (for baseline-only
        # topics); it needs the same expected_hz resolver to label the reference
        # rate and to decide derived coverage.
        self._alerts = AlertEngine(
            alert_rules,
            expected_hz_for=make_expected_hz_resolver(config),
            derived_config=derived_config,
        )
        # Monitor self-load (OL-②.4): on by default; the monitor block can toggle
        # it off to drop all overhead. Times sample-callback latency + snapshot age.
        self._self_load = self._build_self_load(config)
        self._subscriber.set_sink(self._on_sample)
        # The honest "real loss" channel: DDS message_lost events (no decode).
        self._subscriber.set_lost_sink(self._registry.on_sample_lost)

    @staticmethod
    def _build_self_load(config: RecordingConfig | None) -> SelfLoadMonitor | None:
        if config is None:
            return SelfLoadMonitor()
        m = config.monitor
        if not m.self_load_metrics:
            return None
        return SelfLoadMonitor(
            warn_lag_ms=m.callback_lag_warn_ms,
            warn_age_s=m.snapshot_age_warn_s,
        )

    @staticmethod
    def _resolve_windows(config: RecordingConfig | None) -> list[float]:
        if config is None:
            return list(_DEFAULT_WINDOWS_S)
        windows = [float(w) for w in config.monitor.window_s]
        return windows or list(_DEFAULT_WINDOWS_S)

    # -- lifecycle ----------------------------------------------------------

    def start(self) -> None:
        """Seed the allowlist topics and bring the subscriber up."""
        self._seed_allowlist()
        self._subscriber.start()

    def stop(self) -> None:
        self._subscriber.stop()

    def _seed_allowlist(self) -> None:
        """Pre-create a window per ``default_topics`` entry.

        A configured topic that is silent should still report 0 Hz (rather than
        vanish from the snapshot), so we seed its state up front. Glob patterns
        in ``default_topics`` are skipped here — they materialise lazily on the
        first matching sample — but concrete names are seeded.
        """
        if self._config is None:
            return
        for name in self._config.default_topics:
            if not any(ch in name for ch in "*?["):
                self._registry.ensure_topic(name)

    # -- subscriber sink ----------------------------------------------------

    def _on_sample(self, sample: Sample) -> None:
        sl = self._self_load
        if sl is None:
            self._registry.on_sample(sample)
            return
        # Time only how long the registry takes to absorb the sample (no decode).
        t0 = self._perf()
        self._registry.on_sample(sample)
        sl.record_callback((self._perf() - t0) * 1000.0)

    # -- pause / resume -----------------------------------------------------

    def pause(self) -> bool:
        """Pause sample delivery (lighten load, e.g. while recording)."""
        with self._lock:
            self._paused = True
        self._subscriber.pause()
        return True

    def resume(self) -> bool:
        with self._lock:
            self._paused = False
        self._subscriber.resume()
        return False

    @property
    def paused(self) -> bool:
        with self._lock:
            return self._paused

    def is_ready(self) -> bool:
        """Readiness: the underlying node/subscriptions are up."""
        return self._subscriber.is_up()

    # -- snapshots ----------------------------------------------------------

    def metrics_snapshot(self) -> MetricsSnapshot:
        """Return the periodic all-topics metrics snapshot (the /metrics body).

        Cached for a short TTL and shared by every consumer (/metrics, both SSE
        streams, /alerts) so the heavy build — and, with it, the alert hysteresis
        and the baseline-learner tick — runs about once per interval regardless
        of how many consumers ask (MON-M2/M1). See :data:`_SNAPSHOT_TTL_S`.
        """
        with self._snapshot_lock:
            now = self._clock()
            cached = self._cached_snapshot
            if (
                cached is not None
                and self._cached_at is not None
                and now - self._cached_at < _SNAPSHOT_TTL_S
            ):
                return cached
            snapshot = self._build_snapshot(now)
            self._cached_snapshot = snapshot
            self._cached_at = now
            return snapshot

    def _build_snapshot(self, now: float) -> MetricsSnapshot:
        """Compute a fresh all-topics snapshot as of monotonic time *now*."""
        ts = utc_now_iso8601()
        states = self._registry.topics()
        topics = [self._topic_metrics(state, now) for state in states]

        topics_by_name = {t.name: t.model_dump() for t in topics}
        alerts = self._alerts.evaluate(
            topics_by_name, now, ts, now_ns=self._wall_clock_ns()
        )

        allowlist_total, allowlist_matched = self._allowlist_diag(states)
        return MetricsSnapshot(
            ts=ts,
            window_s=int(self._snapshot_window_s),
            topics=topics,
            alerts=alerts,
            paused=self.paused,
            self_load=self._self_load_snapshot(now, states),
            allowlist_total=allowlist_total,
            allowlist_matched=allowlist_matched,
        )

    def _allowlist_diag(self, states: list[TopicState]) -> tuple[int, int]:
        """Allowlist match diagnostics for the snapshot (MON-M4).

        Returns ``(total, matched)`` where *total* is the number of configured
        allowlist patterns (``default_topics``) and *matched* is how many of them
        are matched by a topic that has actually received data (``last_seen_t``
        set). ``matched == 0`` with ``total > 0`` pinpoints the "allowlist matches
        nothing live" cause of an empty ``/metrics`` (usually the wrong robot
        config). Pattern-centric so ``matched <= total`` even with globs, and
        ROS-free (reads only the registry).
        """
        total = len(self._allowlist)
        if total == 0:
            return 0, 0
        seen = [s.name for s in states if s.last_seen_t is not None]
        matched = sum(
            1 for pattern in self._allowlist if any(fnmatch(n, pattern) for n in seen)
        )
        return total, matched

    def _self_load_snapshot(
        self, now: float, states: list[TopicState]
    ) -> MonitorSelfLoad | None:
        """Build the monitor's own-health view (OL-②.4); None when disabled.

        Snapshot age is derived from the freshest *data* (the most recent receive
        time across topics), not from build timing — so it does not depend on how
        many consumers call the snapshot path.
        """
        if self._self_load is None:
            return None
        last_data_t = max(
            (s.last_seen_t for s in states if s.last_seen_t is not None),
            default=None,
        )
        sl = self._self_load.build(now, last_data_t)
        return MonitorSelfLoad(
            callback_lag_ms=sl.callback_lag_ms,
            callback_lag_p95_ms=sl.callback_lag_p95_ms,
            snapshot_age_s=sl.snapshot_age_s,
            status=sl.status,
        )

    def _topic_metrics(self, state: TopicState, now: float) -> TopicMetrics:
        wm = state.window.compute(self._snapshot_window_s, now)
        # Dynamic baseline (OL-②.3): for a topic with no static expected_hz, learn
        # an observed Hz baseline. While learning, leave the raw status as-is
        # (unknown/inactive — never danger); once a baseline exists, judge
        # shortfall against it via the same _health math. Static expected_hz wins
        # (learner is None for those), so this never overrides a configured rate.
        baseline_hz: float | None = None
        baseline_state: str | None = None
        learner = state.baseline_learner
        if learner is not None:
            baseline_state, baseline_hz = learner.update(wm.hz or 0.0, now)
            if baseline_hz is not None:
                wm = state.window.health_with(wm, baseline_hz)
        # Hysteresis: smooth the raw per-window status so one bad tick / GC pause
        # never flips a row red (OL-②.3). Done here, in the single snapshot path.
        # The smoother also carries the reason so it never contradicts the status.
        status = state.status_smoother.update(wm.status, now, wm.status_reason)
        status_reason = state.status_smoother.current_reason
        return TopicMetrics(
            name=state.name,
            type=state.type,
            hz=wm.hz,
            bandwidth_bps=wm.bandwidth_bps,
            gap_max_ms=wm.gap_max_ms,
            gap_exceed_count=wm.gap_exceed_count,
            inter_arrival_late_ratio=wm.inter_arrival_late_ratio,
            stamp_delay_ms=wm.stamp_delay_ms,
            interarrival_p50_ms=wm.interarrival_p50_ms,
            interarrival_p95_ms=wm.interarrival_p95_ms,
            messages_total=state.window.messages_total,
            loss_rate=None,  # true loss not generally computable in ROS 2 (spec)
            dds_samples_lost=state.dds_samples_lost,
            rate_shortfall=wm.rate_shortfall,
            deficit_per_s=wm.deficit_per_s,
            status=status,
            status_reason=status_reason,
            baseline_hz=baseline_hz,
            baseline_state=baseline_state,
            sensor_preview=self._coerce_preview(state.sensor_preview),
            reason=wm.late_reason,
        )

    @staticmethod
    def _coerce_preview(preview: dict[str, object] | None) -> dict[str, object] | None:
        return dict(preview) if preview is not None else None

    def topics(self) -> TopicsResponse:
        """Build the ROS 2 graph discovery response (the /topics body).

        Merges the subscriber's live graph view (publisher/subscriber counts)
        with the registry's per-topic state (resolved QoS, last_seen). A topic
        on the graph that we have not sampled yet still appears (0 counts side);
        a sampled topic missing from the graph still appears via the registry.
        """
        ts = utc_now_iso8601()
        graph = {e.name: e for e in self._subscriber.discover_topics()}
        states = {s.name: s for s in self._registry.topics()}

        infos: list[TopicInfo] = []
        for name in sorted(set(graph) | set(states)):
            entry = graph.get(name)
            state = states.get(name)
            infos.append(
                TopicInfo(
                    name=name,
                    type=(state.type if state else None)
                    or (entry.type if entry else None),
                    publisher_count=entry.publisher_count if entry else 0,
                    subscriber_count=entry.subscriber_count if entry else 0,
                    qos=self._qos_of(state),
                    last_seen=self._last_seen_iso(state),
                )
            )
        return TopicsResponse(ts=ts, topics=infos)

    @staticmethod
    def _qos_of(state: TopicState | None) -> QosInfo | None:
        if state is None or state.qos is None:
            return None
        return state.qos if isinstance(state.qos, QosInfo) else None

    def _last_seen_iso(self, state: TopicState | None) -> str | None:
        """Convert a topic's monotonic ``last_seen_t`` to a UTC ISO8601 string.

        ``last_seen_t`` is a monotonic timestamp; we render it relative to wall
        time via the offset between the two clocks at call time. ``None`` when
        the topic has never received a message.
        """
        if state is None or state.last_seen_t is None:
            return None
        age_s = max(0.0, self._clock() - state.last_seen_t)
        seen = datetime.now(UTC) - timedelta(seconds=age_s)
        return seen.strftime("%Y-%m-%dT%H:%M:%S.") + f"{seen.microsecond // 1000:03d}Z"

    def alerts(self) -> list[Alert]:
        """Alerts firing in the current snapshot (the /alerts body).

        Reads the shared snapshot cache (MON-M2), so /alerts and /alerts/stream
        do not each re-run the full evaluation on every request.
        """
        return self.metrics_snapshot().alerts

    def incidents(self, since_ns: int = 0) -> list[Incident]:
        """Incident-history episodes touched at/after *since_ns* (the /incidents body).

        Forces a fresh snapshot build first so the engine records any transition
        up to ~now (the ring is only advanced during evaluation), then reads the
        bounded history ring — retaining fired+cleared episodes beyond the live
        cleared-retention window. Lets a consumer settle "what fired during a
        recording window" at stop time.
        """
        self.metrics_snapshot()
        return self._alerts.incident_history(since_ns)
