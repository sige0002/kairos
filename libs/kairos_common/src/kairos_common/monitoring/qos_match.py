# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""QoS auto-match for topic_monitor subscriptions.

Goal: subscribe with a QoS *compatible* with every publisher on a topic so we do
not silently miss messages (the #1 ROS 2 footgun: a BEST_EFFORT publisher with a
RELIABLE subscriber connects to nothing). Strategy (see the spec's "QoS 自動マッチ"
section):

1. If RECORDING_CONFIG ``topic_qos_overrides`` matches the topic (first match
   wins), that override takes precedence — operators get the final say.
2. Otherwise use ``best_effort`` reliability even when every publisher is
   reliable. A monitoring reader is an observer, not part of the delivery
   contract: best-effort is compatible with both publisher kinds and avoids
   making a slow or remote monitor eligible for reliable ACK/retry backpressure.
   ``durability`` is ``volatile``; ``depth`` is the smallest offered (keep_last)
   but no shallower than ``default_depth`` (the floor). A depth-1 subscriber was
   field-measured undercounting a bursty topic (27 Hz observed vs 46.6 Hz true):
   with publishers offering depth 1 the subscriber's 1-slot history queue drops
   bursts between executor picks — arrivals are lost *before* we count them. A
   deeper subscriber queue never breaks DDS QoS compatibility, so flooring the
   depth costs only a little memory and stops the undercount.
3. If no publisher info is available (none discovered yet), fall back to
   ``best_effort`` / ``keep_last`` at the configured default depth — the most
   permissive choice, so a late-appearing publisher of any QoS still connects.

This module imports no rclpy at module level (the ``*_str`` normalisers import
it lazily): resolution operates on :class:`QosInfo` values, so it can be
unit-tested by passing synthetic publisher lists.
"""

from __future__ import annotations

from fnmatch import fnmatch

from kairos_common import Durability, RecordingConfig, Reliability
from kairos_common.monitoring.models import QosInfo

# Fallback subscription QoS when nothing is known about the publishers.
_FALLBACK_RELIABILITY = Reliability.best_effort.value
_FALLBACK_DURABILITY = Durability.volatile.value


def reliability_str(value: object) -> str:
    """Normalise an rclpy reliability policy to our string vocabulary."""
    from rclpy.qos import ReliabilityPolicy

    return "best_effort" if value == ReliabilityPolicy.BEST_EFFORT else "reliable"


def durability_str(value: object) -> str:
    """Normalise an rclpy durability policy to our string vocabulary."""
    from rclpy.qos import DurabilityPolicy

    return (
        "transient_local" if value == DurabilityPolicy.TRANSIENT_LOCAL else "volatile"
    )


def publisher_qos_infos(node: object, topic: str) -> list[QosInfo]:
    """Offered QoS of every publisher on *topic*, via an rclpy node's graph API."""
    return [
        QosInfo(
            reliability=reliability_str(info.qos_profile.reliability),
            durability=durability_str(info.qos_profile.durability),
            depth=getattr(info.qos_profile, "depth", 1) or 1,
        )
        for info in node.get_publishers_info_by_topic(topic)  # type: ignore[attr-defined]
    ]


def _config_override(topic: str, config: RecordingConfig | None) -> QosInfo | None:
    """Return the first matching ``topic_qos_overrides`` entry as a QosInfo."""
    if config is None:
        return None
    for override in config.topic_qos_overrides:
        if fnmatch(topic, override.pattern):
            return QosInfo(
                reliability=override.reliability.value,
                durability=override.durability.value,
                depth=override.depth,
            )
    return None


def resolve_subscription_qos(
    topic: str,
    publishers: list[QosInfo],
    config: RecordingConfig | None = None,
    default_depth: int = 10,
) -> QosInfo:
    """Resolve the QoS to subscribe to *topic* with.

    Args:
        topic: Full topic name.
        publishers: Offered QoS of each publisher currently on the topic (may be
            empty if none discovered yet).
        config: RECORDING_CONFIG whose ``topic_qos_overrides`` take precedence.
        default_depth: Queue depth for the no-publisher fallback, and the floor
            for the auto-matched depth (we never subscribe shallower than this).

    Returns:
        The :class:`QosInfo` to build the subscription with.
    """
    override = _config_override(topic, config)
    if override is not None:
        return override

    if not publishers:
        return QosInfo(
            reliability=_FALLBACK_RELIABILITY,
            durability=_FALLBACK_DURABILITY,
            depth=default_depth,
        )

    # Non-intrusive observer: best-effort receives from both reliable and
    # best-effort publishers without adding this monitor to a reliable writer's
    # ACK/retry contract. Sites that explicitly require reliable monitoring can
    # still opt in through topic_qos_overrides above.
    reliability = Reliability.best_effort.value

    # Durability volatile: a volatile subscriber is compatible with both volatile
    # and transient_local publishers, and we do not want replayed history.
    durability = Durability.volatile.value

    # Depth: smallest offered (keep_last), but floored at default_depth. A
    # depth-1 subscriber was field-measured undercounting a bursty topic
    # (27 Hz vs 46.6 Hz true) — bursts dropped from the 1-slot history queue
    # between executor picks, before counting. A deeper subscriber queue never
    # breaks DDS QoS compatibility, so raising the floor only costs memory.
    min_offered = min((max(1, p.depth) for p in publishers), default=default_depth)
    depth = max(min_offered, default_depth)

    return QosInfo(reliability=reliability, durability=durability, depth=depth)
