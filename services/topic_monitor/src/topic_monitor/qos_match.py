"""QoS auto-match for topic_monitor subscriptions.

Goal: subscribe with a QoS *compatible* with every publisher on a topic so we do
not silently miss messages (the #1 ROS 2 footgun: a BEST_EFFORT publisher with a
RELIABLE subscriber connects to nothing). Strategy (see the spec's "QoS 自動マッチ"
section):

1. If RECORDING_CONFIG ``topic_qos_overrides`` matches the topic (first match
   wins), that override takes precedence — operators get the final say.
2. Otherwise auto-match from the offered QoS of every publisher: if *any*
   publisher offers ``best_effort`` we subscribe ``best_effort`` (the compatible
   side — a best_effort sub receives from both reliable and best_effort pubs);
   ``durability`` is ``volatile``; ``depth`` is the smallest offered (keep_last),
   floored at 1, to keep the monitor light.
3. If no publisher info is available (none discovered yet), fall back to
   ``best_effort`` / ``keep_last`` at the configured default depth — the most
   permissive choice, so a late-appearing publisher of any QoS still connects.

This module is pure (no rclpy): it operates on :class:`QosInfo` values, so the
resolution can be unit-tested by passing synthetic publisher lists.
"""

from __future__ import annotations

from fnmatch import fnmatch

from kairos_common import Durability, RecordingConfig, Reliability

from topic_monitor.models import QosInfo

# Fallback subscription QoS when nothing is known about the publishers.
_FALLBACK_RELIABILITY = Reliability.best_effort.value
_FALLBACK_DURABILITY = Durability.volatile.value


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
        default_depth: Queue depth for the no-publisher fallback (and the floor
            from which the auto-matched depth is taken).

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

    # Compatible side: best_effort if ANY publisher is best_effort (a best_effort
    # subscriber is compatible with both reliable and best_effort publishers).
    any_best_effort = any(
        p.reliability == Reliability.best_effort.value for p in publishers
    )
    reliability = (
        Reliability.best_effort.value if any_best_effort else Reliability.reliable.value
    )

    # Durability volatile: a volatile subscriber is compatible with both volatile
    # and transient_local publishers, and we do not want replayed history.
    durability = Durability.volatile.value

    # Smallest offered depth (keep_last), floored at 1 — keep the monitor light.
    depth = min((max(1, p.depth) for p in publishers), default=default_depth)

    return QosInfo(reliability=reliability, durability=durability, depth=depth)
