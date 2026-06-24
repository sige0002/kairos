"""Shared settings, config loader, and FastAPI helpers for kairos services.

Stage 0 skeleton: this package holds the plumbing every service shares
(infrastructure settings, the recording/monitoring config loader, and the
FastAPI app factory). It contains no service-specific business logic.

See ``docs/specs/ja/config.md`` for the canonical three-layer config design.
"""

from __future__ import annotations

from kairos_common.app import create_app, error_response
from kairos_common.errors import ApiError, ErrorBody, ErrorModel
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

__all__ = [
    "ApiError",
    "Compression",
    "Durability",
    "ErrorBody",
    "ErrorModel",
    "ExpectedHzPattern",
    "JobState",
    "MonitorConfig",
    "RecordingConfig",
    "RecordingTuning",
    "Reliability",
    "RequiredTopic",
    "Settings",
    "Storage",
    "StreamConfig",
    "StreamPane",
    "TopicQosOverride",
    "ValidationConfig",
    "create_app",
    "error_response",
    "get_settings",
    "load_recording_config",
    "load_stream_config",
    "utc_now_iso8601",
]
