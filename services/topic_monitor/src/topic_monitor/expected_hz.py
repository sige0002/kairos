"""Resolve a topic's expected Hz from RECORDING_CONFIG patterns (first match).

``expected_hz_patterns`` in the recording config maps glob patterns to an
expected rate; the first pattern that matches a topic wins (per the spec). A
pattern whose ``hz`` is omitted means "learn the rate dynamically" — for Stage 2
that yields ``None`` (no static expectation), so the topic gets Hz/bandwidth/gap
only and the Late metrics are null with a reason. Matching is fnmatch glob, the
same rule the recorder's QoS resolution uses.
"""

from __future__ import annotations

from collections.abc import Callable
from fnmatch import fnmatch

from kairos_common import RecordingConfig


def make_expected_hz_resolver(
    config: RecordingConfig | None,
) -> Callable[[str], float | None]:
    """Return ``resolver(topic) -> expected_hz | None`` (first-match-wins).

    With no config (or no patterns) every topic resolves to ``None``. A matching
    pattern with no ``hz`` also resolves to ``None`` (dynamic learning is out of
    Stage 2 scope), which the metric layer reports as a Late ``reason``.
    """
    patterns = list(config.expected_hz_patterns) if config is not None else []

    def resolver(topic: str) -> float | None:
        for entry in patterns:
            if fnmatch(topic, entry.pattern):
                return entry.hz
        return None

    return resolver
