# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""QoS auto-match: compatible-side resolution + config-override precedence."""

from __future__ import annotations

from kairos_common import (
    Durability,
    RecordingConfig,
    Reliability,
    TopicQosOverride,
)
from kairos_common.monitoring.models import QosInfo
from kairos_common.monitoring.qos_match import resolve_subscription_qos


def _qos(reliability: str, durability: str = "volatile", depth: int = 10) -> QosInfo:
    return QosInfo(reliability=reliability, durability=durability, depth=depth)


def test_any_best_effort_publisher_forces_best_effort() -> None:
    pubs = [_qos("reliable", depth=20), _qos("best_effort", depth=15)]
    qos = resolve_subscription_qos("/cam", pubs)
    # A best_effort subscriber is compatible with both pub kinds.
    assert qos.reliability == Reliability.best_effort.value
    assert qos.durability == Durability.volatile.value
    # Smallest offered depth wins when it clears the default floor (10).
    assert qos.depth == 15


def test_all_reliable_publishers_resolve_reliable() -> None:
    pubs = [_qos("reliable", depth=10), _qos("reliable", depth=20)]
    qos = resolve_subscription_qos("/topic", pubs)
    assert qos.reliability == Reliability.reliable.value
    assert qos.depth == 10


def test_no_publishers_falls_back_to_best_effort() -> None:
    qos = resolve_subscription_qos("/late", [], default_depth=7)
    assert qos.reliability == Reliability.best_effort.value
    assert qos.durability == Durability.volatile.value
    assert qos.depth == 7


def test_config_override_takes_precedence_over_publishers() -> None:
    config = RecordingConfig(
        robot_name="hsr",
        topic_qos_overrides=[
            TopicQosOverride(
                pattern="/cam/*",
                reliability=Reliability.reliable,
                durability=Durability.transient_local,
                depth=3,
            )
        ],
    )
    # Even though the only publisher is best_effort, the override wins.
    qos = resolve_subscription_qos(
        "/cam/front", [_qos("best_effort", depth=1)], config=config
    )
    assert qos.reliability == Reliability.reliable.value
    assert qos.durability == Durability.transient_local.value
    assert qos.depth == 3


def test_config_override_only_applies_on_pattern_match() -> None:
    config = RecordingConfig(
        robot_name="hsr",
        topic_qos_overrides=[
            TopicQosOverride(
                pattern="/cam/*",
                reliability=Reliability.reliable,
                durability=Durability.volatile,
                depth=3,
            )
        ],
    )
    # Non-matching topic falls through to publisher auto-match.
    qos = resolve_subscription_qos(
        "/joint_states", [_qos("best_effort", depth=20)], config=config
    )
    assert qos.reliability == Reliability.best_effort.value
    # Auto-matched to the offered depth (above the floor), not the override's 3.
    assert qos.depth == 20


def test_depth_floored_at_one() -> None:
    # A degenerate depth-0 publisher never yields a depth-0 subscription; with
    # the floor set to 1 the max(1, ...) guard still lands the result at 1.
    qos = resolve_subscription_qos("/t", [_qos("reliable", depth=0)], default_depth=1)
    assert qos.depth == 1


def test_default_depth_is_a_floor_for_auto_match() -> None:
    # Field fix: a shallow publisher must not force a shallow (undercounting)
    # subscriber. The auto-matched depth is floored at default_depth.
    shallow = resolve_subscription_qos(
        "/burst",
        [_qos("best_effort", depth=1), _qos("reliable", depth=5)],
        default_depth=30,
    )
    assert shallow.depth == 30
    # A deeper offer above the floor is honoured (smallest offered wins).
    deep = resolve_subscription_qos(
        "/deep", [_qos("reliable", depth=50)], default_depth=30
    )
    assert deep.depth == 50
