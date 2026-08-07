"""expected_hz resolver: first-match-wins glob, None for omitted/unmatched."""

from __future__ import annotations

from kairos_common import ExpectedHzPattern, RecordingConfig
from kairos_common.monitoring.expected_hz import make_expected_hz_resolver


def _config(patterns: list[ExpectedHzPattern]) -> RecordingConfig:
    return RecordingConfig(robot_name="hsr", expected_hz_patterns=patterns)


def test_first_matching_pattern_wins() -> None:
    config = _config(
        [
            ExpectedHzPattern(pattern="/camera/*/image_raw", hz=30.0),
            ExpectedHzPattern(pattern="/camera/*", hz=5.0),
        ]
    )
    resolver = make_expected_hz_resolver(config)
    # The first (more specific) pattern wins even though both match.
    assert resolver("/camera/front/image_raw") == 30.0
    # Only the second pattern matches here.
    assert resolver("/camera/front/info") == 5.0


def test_unmatched_topic_resolves_none() -> None:
    config = _config([ExpectedHzPattern(pattern="/camera/*", hz=30.0)])
    resolver = make_expected_hz_resolver(config)
    assert resolver("/joint_states") is None


def test_matching_pattern_without_hz_resolves_none() -> None:
    # A pattern with hz omitted means "learn dynamically" -> None in Stage 2.
    config = _config([ExpectedHzPattern(pattern="/joint_states")])
    resolver = make_expected_hz_resolver(config)
    assert resolver("/joint_states") is None


def test_no_config_resolves_none() -> None:
    resolver = make_expected_hz_resolver(None)
    assert resolver("/anything") is None
