"""The monitoring service: subscriber -> registry -> snapshot (ROS-free core).

:class:`MonitorService` is the heart of topic_monitor. It owns a
:class:`~topic_monitor.subscriber.TopicSubscriber` (the ROS seam), wires its
samples into the :class:`~topic_monitor.metrics.MetricsRegistry`, and turns the
accumulated windows into the API response models (``MetricsSnapshot`` /
``TopicsResponse`` / ``AlertsResponse``). Pause/resume forward to the subscriber.

It depends only on the :class:`TopicSubscriber` Protocol, never on rclpy, so the
full path — sample in, snapshot out, alerts evaluated — is unit-testable by
injecting a :class:`~topic_monitor.subscriber.FakeSubscriber` and feeding
synthetic samples. ``main.py`` injects the real rclpy-backed subscriber instead.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from kairos_common import RecordingConfig, utc_now_iso8601

from topic_monitor.alerts import AlertEngine
from topic_monitor.expected_hz import make_expected_hz_resolver
from topic_monitor.metrics import MetricsRegistry, TopicState
from topic_monitor.models import (
    Alert,
    AlertRule,
    MetricsSnapshot,
    QosInfo,
    TopicInfo,
    TopicMetrics,
    TopicsResponse,
)
from topic_monitor.subscriber import Sample, TopicSubscriber

# Default sliding windows if the RECORDING_CONFIG monitor block is unavailable.
_DEFAULT_WINDOWS_S: list[float] = [1.0, 5.0]


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
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._subscriber = subscriber
        self._config = config
        self._clock = clock
        self._lock = threading.Lock()
        self._paused = False

        windows = self._resolve_windows(config)
        # The snapshot window is the largest configured (gives the most stable
        # rate); shorter windows stay available in the registry for future use.
        self._snapshot_window_s = windows[-1]
        # Status thresholds + hysteresis come from the RECORDING_CONFIG monitor
        # block (config-driven, not hardcoded); the registry defaults apply when
        # there is no config.
        reg_kwargs: dict[str, float] = {}
        if config is not None:
            m = config.monitor
            reg_kwargs = {
                "warn_shortfall": m.warn_shortfall,
                "danger_shortfall": m.danger_shortfall,
                "min_status_count": m.min_status_count,
                "escalate_after_s": m.status_escalate_s,
                "recover_after_s": m.status_recover_s,
            }
        self._registry = MetricsRegistry(
            windows,
            expected_hz_for=make_expected_hz_resolver(config),
            **reg_kwargs,
        )
        self._alerts = AlertEngine(alert_rules)
        self._subscriber.set_sink(self._on_sample)
        # The honest "real loss" channel: DDS message_lost events (no decode).
        self._subscriber.set_lost_sink(self._registry.on_sample_lost)

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
        self._registry.on_sample(sample)

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
        """Build the periodic all-topics metrics snapshot (the /metrics body)."""
        now = self._clock()
        ts = utc_now_iso8601()
        states = self._registry.topics()
        topics = [self._topic_metrics(state, now) for state in states]

        topics_by_name = {t.name: t.model_dump() for t in topics}
        alerts = self._alerts.evaluate(topics_by_name, now, ts)

        return MetricsSnapshot(
            ts=ts,
            window_s=int(self._snapshot_window_s),
            topics=topics,
            alerts=alerts,
            paused=self.paused,
        )

    def _topic_metrics(self, state: TopicState, now: float) -> TopicMetrics:
        wm = state.window.compute(self._snapshot_window_s, now)
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
            loss_rate=None,  # true loss not generally computable in ROS 2 (spec)
            dds_samples_lost=state.dds_samples_lost,
            rate_shortfall=wm.rate_shortfall,
            deficit_per_s=wm.deficit_per_s,
            status=status,
            status_reason=status_reason,
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
        """Evaluate alerts against the current snapshot (the /alerts body)."""
        return self.metrics_snapshot().alerts
