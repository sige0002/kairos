"""Backward-compatible re-export — the introspection core now lives in the lib.

The pure numeric-field introspection logic moved to
:mod:`kairos_common.field_introspect` so both consumers share one
implementation: topic_probe's live plotter (:mod:`topic_probe.probe`) and
dora_runner's post-hoc ``signal_report`` pipeline. It stays pure logic
(ROS-agnostic, unit-testable with plain Python objects); see that module for the
walk semantics and the array/depth/field caps.

This shim keeps ``topic_probe.field_introspect`` importable for existing call
sites and tests. Import from :mod:`kairos_common` in new code.
"""

from __future__ import annotations

from kairos_common.field_introspect import (
    DEFAULT_MAX_ARRAY,
    DEFAULT_MAX_DEPTH,
    DEFAULT_MAX_FIELDS,
    extract_value,
    iter_numeric_fields,
    parse_path,
)

__all__ = [
    "DEFAULT_MAX_ARRAY",
    "DEFAULT_MAX_DEPTH",
    "DEFAULT_MAX_FIELDS",
    "extract_value",
    "iter_numeric_fields",
    "parse_path",
]
