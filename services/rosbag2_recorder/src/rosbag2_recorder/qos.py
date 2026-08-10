"""Build the ``--qos-profile-overrides-path`` YAML for ``ros2 bag record``.

By default rosbag2 records each topic with the QoS its publisher offers, which
is what we want for the airoa cameras (they publish ``best_effort`` — recording
``reliable`` would silently fail to connect). When the deployment config
(``recording.yaml`` ``topic_qos_overrides``) or the request specifies a QoS for
a topic, we materialise a small YAML file mapping topic name -> QoS profile and
pass it to ``ros2 bag record`` so the override is applied for that subscription.

The override file format is the one rosbag2 documents: a top-level mapping keyed
by full topic name, each value a profile with ``reliability`` / ``durability`` /
``history`` / ``depth`` (string enums in the rmw vocabulary).

Matching against ``recording.yaml`` patterns is glob (fnmatch), first match wins
(the same rule the spec states for the pattern lists). An explicit per-request
override for a concrete topic takes precedence over the config patterns.
"""

from __future__ import annotations

from fnmatch import fnmatch
from pathlib import Path

import yaml
from kairos_common import RecordingConfig
from kairos_common.recording_config import TopicQosOverride

from rosbag2_recorder.models import QosProfile

# rosbag2 / rmw QoS override file uses KEEP_LAST history with an explicit depth;
# that matches how the recording config expresses QoS (reliability/durability/
# depth) so we always emit KEEP_LAST.
_HISTORY_KEEP_LAST = "keep_last"


def resolve_topic_qos(
    topic: str,
    config: RecordingConfig | None,
    request_overrides: dict[str, QosProfile] | None,
    qos_default: QosProfile | None = None,
    request_patterns: list[TopicQosOverride] | None = None,
) -> QosProfile | None:
    """Resolve the QoS override for *topic*, or ``None`` to follow the publisher.

    Precedence:
      1. an explicit per-request override for this exact topic name, then
      2. the first matching pattern the REQUEST carried
         (``qos_override_patterns`` — the orchestrator's live config, which
         supersedes this process's startup copy after a robot switch), then
      3. the first matching ``topic_qos_overrides`` pattern in *config*
         (this process's own startup config — consulted only when the request
         carried no pattern list at all), then
      4. the request's ``qos_default`` (applied to every otherwise-unmatched
         topic when the caller supplied one).

    A request that carries a pattern list REPLACES the startup config's list
    rather than layering on it, empty list included: the caller is asserting
    what the live config says, and "no overrides" is an assertion too.

    Returns ``None`` only when none of the above apply (no per-topic override,
    no pattern match, and no ``qos_default``), meaning "let rosbag2 adapt to the
    publisher's offered QoS" — the default behaviour and the correct one for the
    best_effort cameras when the caller does not force a default.
    """
    if request_overrides and topic in request_overrides:
        return request_overrides[topic]
    if request_patterns is not None:
        for override in request_patterns:
            if fnmatch(topic, override.pattern):
                return QosProfile(
                    reliability=override.reliability,
                    durability=override.durability,
                    depth=override.depth,
                )
    elif config is not None:
        for override in config.topic_qos_overrides:
            if fnmatch(topic, override.pattern):
                return QosProfile(
                    reliability=override.reliability,
                    durability=override.durability,
                    depth=override.depth,
                )
    return qos_default


def _profile_to_rosbag2(qos: QosProfile) -> dict[str, object]:
    """Render a :class:`QosProfile` as a rosbag2 QoS-override mapping."""
    return {
        "history": _HISTORY_KEEP_LAST,
        "depth": qos.depth,
        "reliability": qos.reliability.value,
        "durability": qos.durability.value,
    }


def build_qos_overrides(
    topics: list[str],
    config: RecordingConfig | None,
    request_overrides: dict[str, QosProfile] | None,
    qos_default: QosProfile | None = None,
    request_patterns: list[TopicQosOverride] | None = None,
) -> dict[str, dict[str, object]]:
    """Build the topic -> QoS-profile mapping for the selected *topics*.

    Only topics that resolve to a concrete override (per-topic, request or
    config pattern, or *qos_default*) are included; topics left to follow the
    publisher are omitted so rosbag2 keeps adapting to them.
    """
    overrides: dict[str, dict[str, object]] = {}
    for topic in topics:
        qos = resolve_topic_qos(
            topic, config, request_overrides, qos_default, request_patterns
        )
        if qos is not None:
            overrides[topic] = _profile_to_rosbag2(qos)
    return overrides


def write_qos_overrides_file(
    overrides: dict[str, dict[str, object]], dest: str | Path
) -> Path | None:
    """Write *overrides* to *dest* as YAML; return the path, or ``None`` if empty.

    An empty mapping means no overrides apply, so no file is written and the
    caller should not pass ``--qos-profile-overrides-path``.
    """
    if not overrides:
        return None
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(yaml.safe_dump(overrides, sort_keys=True), encoding="utf-8")
    return dest
