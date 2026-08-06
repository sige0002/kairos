"""Shared settings, config loader, and FastAPI helpers for kairos services.

This package holds the plumbing every service shares (infrastructure settings,
the recording/monitoring config loader, and the FastAPI app factory). It
contains no service-specific business logic.

See ``docs/specs/ja/config.md`` for the canonical three-layer config design.
"""

from __future__ import annotations

# The capture-store v2 subsystem is exported as MODULES, never as loose names.
# ``rebuild`` is both a module and its main function, and a top-level re-export
# would make ``kairos_common.rebuild`` mean one thing here and the other in
# ``from kairos_common.rebuild import rebuild``. One style for all six keeps the
# call sites unambiguous: ``ids.uuid7()``, ``rebuild.rebuild(...)``, or an
# explicit ``from kairos_common.capture_sidecars import ObjectManifestV2``.
from kairos_common import (
    atomic_io,
    capture_sidecars,
    ids,
    instance,
    ledger_v2,
    rebuild,
)
from kairos_common.app import create_app
from kairos_common.archive_paths import archive_enabled, parse_archive_roots
from kairos_common.config_path import resolve_config_path
from kairos_common.errors import ApiError
from kairos_common.field_introspect import (
    DEFAULT_MAX_FIELDS,
    extract_value,
    iter_numeric_fields,
)
from kairos_common.recording_config import (
    Compression,
    Durability,
    ExpectedHzPattern,
    RecordingConfig,
    RecordingTuning,
    Reliability,
    TopicQosOverride,
    ValidationConfig,
    load_recording_config,
    load_recording_config_or_none,
)
from kairos_common.settings import Settings, get_settings
from kairos_common.states import JobState
from kairos_common.stream_config import StreamConfig, load_stream_config
from kairos_common.time import utc_now_iso8601
from kairos_common.validation_config import (
    ValidationTemplate,
    load_validation_template,
)

# Only names that are actually imported from the package root live here; the
# rest of each module's surface is reached as ``kairos_common.<module>`` (e.g.
# ``from kairos_common.bag_metadata import topic_signature``). A re-export no
# call site uses is a second name for the same thing that has to be kept in
# step with the first.
__all__ = [
    "ApiError",
    "Compression",
    "DEFAULT_MAX_FIELDS",
    "Durability",
    "ExpectedHzPattern",
    "JobState",
    "RecordingConfig",
    "RecordingTuning",
    "Reliability",
    "Settings",
    "StreamConfig",
    "TopicQosOverride",
    "ValidationConfig",
    "ValidationTemplate",
    "archive_enabled",
    "atomic_io",
    "capture_sidecars",
    "create_app",
    "extract_value",
    "get_settings",
    "ids",
    "instance",
    "iter_numeric_fields",
    "ledger_v2",
    "load_recording_config",
    "load_recording_config_or_none",
    "load_stream_config",
    "load_validation_template",
    "parse_archive_roots",
    "rebuild",
    "resolve_config_path",
    "utc_now_iso8601",
]
