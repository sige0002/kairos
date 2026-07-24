"""Shared live-monitoring engine (ROS-free core) for kairos services.

This package holds the windowed-metric math, the alert incident engine, and the
:class:`MonitorService` that turns a stream of :class:`Sample` records into the
API response models — none of it depends on rclpy. It was extracted from
``topic_monitor`` so more than one service can drive the same engine: the ROS
seam (:class:`TopicSubscriber`) is injected, and the real rclpy-backed
implementation lives in the consuming service (e.g. ``topic_monitor``'s
``ros_subscriber``). See ``docs/specs/ja/topic_monitor.md``.
"""

from __future__ import annotations

from kairos_common.monitoring.alert_config import (
    load_alert_rules,
    load_derived_config,
)
from kairos_common.monitoring.alerts import AlertEngine, metric_value
from kairos_common.monitoring.expected_hz import make_expected_hz_resolver
from kairos_common.monitoring.metrics import (
    BaselineLearner,
    MetricsRegistry,
    SelfLoadMetrics,
    SelfLoadMonitor,
    StatusSmoother,
    TopicState,
    TopicWindow,
    WindowMetrics,
)
from kairos_common.monitoring.models import (
    Alert,
    AlertMetric,
    AlertOp,
    AlertRule,
    AlertsResponse,
    BaselineState,
    DerivedRulesConfig,
    Incident,
    IncidentsResponse,
    MetricsSnapshot,
    MonitorSelfLoad,
    PauseResponse,
    QosInfo,
    SelfLoadStatus,
    TopicInfo,
    TopicMetrics,
    TopicsResponse,
    TopicStatus,
)
from kairos_common.monitoring.monitor import MonitorService
from kairos_common.monitoring.qos_match import (
    durability_str,
    publisher_qos_infos,
    reliability_str,
    resolve_subscription_qos,
)
from kairos_common.monitoring.subscriber import (
    FakeSubscriber,
    PublisherInfo,
    Sample,
    TopicGraphEntry,
    TopicSubscriber,
)

__all__ = [
    "Alert",
    "AlertEngine",
    "AlertMetric",
    "AlertOp",
    "AlertRule",
    "AlertsResponse",
    "BaselineLearner",
    "BaselineState",
    "DerivedRulesConfig",
    "FakeSubscriber",
    "Incident",
    "IncidentsResponse",
    "MetricsRegistry",
    "MetricsSnapshot",
    "MonitorSelfLoad",
    "MonitorService",
    "PauseResponse",
    "PublisherInfo",
    "QosInfo",
    "Sample",
    "SelfLoadMetrics",
    "SelfLoadMonitor",
    "SelfLoadStatus",
    "StatusSmoother",
    "TopicGraphEntry",
    "TopicInfo",
    "TopicMetrics",
    "TopicState",
    "TopicStatus",
    "TopicSubscriber",
    "TopicWindow",
    "TopicsResponse",
    "WindowMetrics",
    "load_alert_rules",
    "load_derived_config",
    "make_expected_hz_resolver",
    "metric_value",
    "durability_str",
    "publisher_qos_infos",
    "reliability_str",
    "resolve_subscription_qos",
]
