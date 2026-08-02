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
from kairos_common.app import REQUEST_ID_HEADER, create_app, error_response
from kairos_common.archive_paths import (
    ARCHIVE_ROOTS_SEPARATOR,
    archive_enabled,
    parse_archive_roots,
    resolve_archive_destination,
)
from kairos_common.bag_metadata import (
    TOPIC_SIGNATURE_ALGO,
    TopicSignature,
    read_bag_metadata,
    signature_from_metadata,
    topic_signature,
)
from kairos_common.config_path import resolve_config_path
from kairos_common.errors import ApiError, ErrorBody, ErrorModel
from kairos_common.field_introspect import (
    DEFAULT_MAX_ARRAY,
    DEFAULT_MAX_DEPTH,
    DEFAULT_MAX_FIELDS,
    extract_value,
    iter_numeric_fields,
    parse_path,
)
from kairos_common.logging import get_request_id, reset_request_id, set_request_id
from kairos_common.recording_config import (
    Compression,
    Durability,
    ExpectedHzPattern,
    MonitorConfig,
    RecordingConfig,
    RecordingTuning,
    Reliability,
    RequiredTopic,
    Storage,
    TopicQosOverride,
    ValidationConfig,
    load_recording_config,
)
from kairos_common.settings import Settings, get_settings
from kairos_common.states import JobState
from kairos_common.stream_config import StreamConfig, StreamPane, load_stream_config
from kairos_common.time import utc_now_iso8601
from kairos_common.validation_config import (
    RequiredTopic as ValidationRequiredTopic,
)
from kairos_common.validation_config import (
    ValidationTemplate,
    load_validation_template,
)

__all__ = [
    "ARCHIVE_ROOTS_SEPARATOR",
    "ApiError",
    "Compression",
    "DEFAULT_MAX_ARRAY",
    "DEFAULT_MAX_DEPTH",
    "DEFAULT_MAX_FIELDS",
    "Durability",
    "ErrorBody",
    "ErrorModel",
    "ExpectedHzPattern",
    "JobState",
    "MonitorConfig",
    "REQUEST_ID_HEADER",
    "RecordingConfig",
    "RecordingTuning",
    "Reliability",
    "RequiredTopic",
    "Settings",
    "Storage",
    "StreamConfig",
    "StreamPane",
    "TOPIC_SIGNATURE_ALGO",
    "TopicQosOverride",
    "TopicSignature",
    "ValidationConfig",
    "ValidationRequiredTopic",
    "ValidationTemplate",
    "archive_enabled",
    "atomic_io",
    "capture_sidecars",
    "create_app",
    "error_response",
    "extract_value",
    "get_request_id",
    "get_settings",
    "ids",
    "instance",
    "iter_numeric_fields",
    "ledger_v2",
    "load_recording_config",
    "load_stream_config",
    "load_validation_template",
    "parse_archive_roots",
    "parse_path",
    "read_bag_metadata",
    "rebuild",
    "reset_request_id",
    "resolve_archive_destination",
    "resolve_config_path",
    "set_request_id",
    "signature_from_metadata",
    "topic_signature",
    "utc_now_iso8601",
]
