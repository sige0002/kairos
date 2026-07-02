"""Pydantic models for the topic_monitor API (Stage 2).

These shapes are the public contract of topic_monitor (consumed by
``api_orchestrator`` and the frontend). They are pydantic models so the OpenAPI
schema is generated and the output matches the example in
``docs/specs/ja/topic_monitor.md`` exactly. Timestamps are UTC ISO8601 and
numeric fields carry unit suffixes (``*_ms`` / ``*_bps``) per ``config.md``.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Any

from pydantic import BaseModel, Field


class AlertMetric(StrEnum):
    """Metric an alert rule watches (shared vocabulary from config.md)."""

    hz = "hz"
    bandwidth = "bandwidth"
    gap = "gap"
    late = "late"
    loss = "loss"


class AlertOp(StrEnum):
    """Comparison operator for an alert rule (shared vocabulary from config.md)."""

    lt = "lt"
    gt = "gt"
    le = "le"
    ge = "ge"


class TopicStatus(StrEnum):
    """Coarse per-topic health, by descending severity (OL-②.2).

    ``inactive`` = silent (no messages in the window); ``danger`` / ``warning`` =
    observed shortfall vs ``expected_hz`` crossed the danger/warning threshold;
    ``ok`` = on rate; ``unknown`` = no ``expected_hz`` to judge against. This is
    observed shortfall (see ``rate_shortfall``), not true message loss.
    """

    inactive = "inactive"
    danger = "danger"
    warning = "warning"
    ok = "ok"
    unknown = "unknown"


class BaselineState(StrEnum):
    """Dynamic-baseline learning state for a topic with no static expected_hz.

    ``learning`` = still warming up (status stays ``unknown``, never danger);
    ``stable`` = a low-variance baseline was adopted as the shortfall reference;
    ``unstable`` = a previously-stable baseline became noisy (last good one is
    kept). Only set for topics without a static ``expected_hz`` (OL-②.3).
    """

    learning = "learning"
    stable = "stable"
    unstable = "unstable"


class SelfLoadStatus(StrEnum):
    """Coarse health of the monitor's OWN processing (OL-②.4)."""

    ok = "ok"
    warning = "warning"
    danger = "danger"


class TopicMetrics(BaseModel):
    """Windowed metrics for a single topic.

    Mirrors the per-topic object in the spec's output example. ``hz`` /
    ``bandwidth_bps`` / ``gap_max_ms`` are always computed once samples arrive.
    The Late split (``inter_arrival_late_ratio`` + ``stamp_delay_ms``) and
    ``loss_rate`` are ``null`` when they cannot be computed; ``reason`` then says
    why (e.g. no ``expected_hz`` configured, or no usable ``header.stamp``).
    """

    name: str
    type: str | None = None
    hz: float | None = None
    bandwidth_bps: float | None = None
    gap_max_ms: float | None = None
    # Count of receive-gaps that exceeded the expected period (Late threshold).
    gap_exceed_count: int = 0
    inter_arrival_late_ratio: float | None = None
    stamp_delay_ms: float | None = None
    # Inter-arrival jitter from receive times (no decode): p50/p95 + max gap are
    # the honest live "is it choppy" signal (OL-②.5-lite).
    interarrival_p50_ms: float | None = None
    interarrival_p95_ms: float | None = None
    loss_rate: float | None = None
    # Cumulative DDS sample-lost count (rmw message_lost event). The ONE honest
    # "real loss" signal without sequence numbers — distinct from rate_shortfall.
    dds_samples_lost: int = 0
    # Observed shortfall vs static expected_hz (OL-②.1). NOT true loss — see
    # the metrics module docstring. ``null`` without an expected_hz.
    rate_shortfall: float | None = None
    deficit_per_s: float | None = None
    # Coarse per-topic health + why (OL-②.2). Derived from rate_shortfall.
    status: TopicStatus = TopicStatus.unknown
    status_reason: str | None = None
    # Dynamic baseline (OL-②.3): learned Hz reference used to judge shortfall when
    # the topic has no static expected_hz. ``baseline_state`` is ``learning``
    # during warm-up (status held ``unknown``), then ``stable`` / ``unstable``.
    # ``baseline_hz`` is null until a stable baseline exists.
    baseline_hz: float | None = None
    baseline_state: BaselineState | None = None
    sensor_preview: dict[str, Any] | None = None
    # Why Late/Loss are null (only set when they are), e.g. "no expected_hz".
    reason: str | None = None


class MonitorSelfLoad(BaseModel):
    """The monitor process's OWN processing health (OL-②.4).

    Reported separately from topic health and never derived from decoding
    payloads — it times how long the monitor takes to absorb each sample and how
    stale the snapshot it serves is. Lets the UI tell "the topics are slow" apart
    from "the monitor itself is overloaded". ``null`` on the snapshot when
    self-load metrics are disabled.
    """

    # Mean / p95 sample-callback processing time over the window (milliseconds).
    callback_lag_ms: float | None = None
    callback_lag_p95_ms: float | None = None
    # Staleness of the freshest data the monitor holds (s), from the most recent
    # receive time across active topics — large = the monitor is falling behind.
    snapshot_age_s: float | None = None
    status: SelfLoadStatus = SelfLoadStatus.ok


class MetricsSnapshot(BaseModel):
    """A periodic snapshot of all monitored topics (the /metrics body).

    The same shape is pushed over ``GET /metrics/stream`` (SSE) — a full
    snapshot each tick, not a diff, so the UI stays simple (per the spec).
    """

    ts: str
    window_s: int
    topics: list[TopicMetrics] = Field(default_factory=list)
    alerts: list[Alert] = Field(default_factory=list)
    # True while monitoring is paused (POST /metrics/pause); metrics go stale.
    paused: bool = False
    # The monitor's own processing health (OL-②.4); null when self-load is off.
    self_load: MonitorSelfLoad | None = None
    # Allowlist diagnostics (MON-M4): how many configured allowlist patterns
    # (RECORDING_CONFIG default_topics) there are, and how many are matched by a
    # topic that has actually produced data. ``allowlist_matched == 0`` while
    # ``allowlist_total > 0`` means the allowlist matches nothing live — the usual
    # reason ``topics`` is empty (e.g. the wrong robot's config is selected).
    # Additive: both 0 when there is no config.
    allowlist_total: int = 0
    allowlist_matched: int = 0


class QosInfo(BaseModel):
    """Resolved QoS a subscription uses / a discovered publisher offers."""

    reliability: str
    durability: str
    depth: int


class TopicInfo(BaseModel):
    """ROS 2 graph discovery entry (the /topics body).

    This is ``api_orchestrator``'s source for ``GET /api/v1/topics``. ``qos`` is
    the QoS the monitor resolved for its subscription (auto-matched to the
    publishers); ``last_seen`` is the UTC time a message last arrived, or
    ``null`` if none has yet.
    """

    name: str
    type: str | None = None
    publisher_count: int = 0
    subscriber_count: int = 0
    qos: QosInfo | None = None
    last_seen: str | None = None


class TopicsResponse(BaseModel):
    """Body of ``GET /topics``."""

    ts: str
    topics: list[TopicInfo] = Field(default_factory=list)


class AlertRule(BaseModel):
    """An alert rule: fire when ``metric`` ``op`` ``threshold`` holds for a topic.

    ``cooldown_s`` suppresses re-firing after an alert clears; ``clear_after_s``
    is how long the condition must stay false before the alert clears
    (hysteresis), per the spec.
    """

    topic: str
    metric: AlertMetric
    op: AlertOp
    threshold: float
    cooldown_s: Annotated[float, Field(ge=0)] = 0.0
    clear_after_s: Annotated[float, Field(ge=0)] = 0.0


class Alert(BaseModel):
    """An active or recently-cleared alert instance."""

    topic: str
    metric: AlertMetric
    op: AlertOp
    threshold: float
    value: float | None = None
    state: str = "firing"  # "firing" | "cleared"
    since: str | None = None


class AlertsResponse(BaseModel):
    """Body of ``GET /alerts``."""

    ts: str
    alerts: list[Alert] = Field(default_factory=list)


class PauseResponse(BaseModel):
    """Body of ``POST /metrics/pause`` and ``POST /metrics/resume``."""

    paused: bool


# MetricsSnapshot references Alert (declared after it); rebuild to resolve.
MetricsSnapshot.model_rebuild()
