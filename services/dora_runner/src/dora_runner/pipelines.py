"""Pipeline registry."""

from __future__ import annotations

from dora_runner.models import PipelineDefinition

FAST_VALIDATION_SCHEMA = {
    "type": "object",
    "required": ["template"],
    "properties": {"template": {"type": "string"}},
}

# dataset_export needs no params beyond the top-level run_id (operator/task are
# read from the run's session.json).
DATASET_EXPORT_SCHEMA = {"type": "object", "properties": {}}

# loss_report is config-free: it only needs the top-level run_id.
LOSS_REPORT_SCHEMA = {"type": "object", "properties": {}}

# video_check needs the camera topic to render (besides the top-level run_id).
VIDEO_CHECK_SCHEMA = {
    "type": "object",
    "required": ["topic"],
    "properties": {"topic": {"type": "string"}},
}

PIPELINES = [
    PipelineDefinition(
        id="fast_validation",
        name="Fast validation",
        description="Required-topic presence check for recorded MCAP runs.",
        enabled=True,
        schema=FAST_VALIDATION_SCHEMA,
    ),
    PipelineDefinition(
        id="dataset_export",
        name="Dataset export",
        description=(
            "Copy a recorded run into data/<operator>/<task>/<NNN> (from "
            "session.json). Read-only on the canonical recording."
        ),
        enabled=True,
        schema=DATASET_EXPORT_SCHEMA,
    ),
    PipelineDefinition(
        id="loss_report",
        name="Loss report",
        description="Per-topic gap-based loss estimate from a recorded MCAP.",
        enabled=True,
        schema=LOSS_REPORT_SCHEMA,
    ),
    PipelineDefinition(
        id="video_check",
        name="Video check",
        description="On-demand mp4 preview of a camera topic from a recorded MCAP.",
        enabled=True,
        schema=VIDEO_CHECK_SCHEMA,
    ),
    PipelineDefinition(
        id="full_validation",
        name="Full validation",
        description="Interface-only placeholder for deeper validation.",
        enabled=False,
        schema={},
    ),
    PipelineDefinition(
        id="dataset_convert",
        name="Dataset conversion",
        description="Interface-only placeholder for format conversion (LeRobot/RLDS).",
        enabled=False,
        schema={},
    ),
    PipelineDefinition(
        id="dataset_validation",
        name="Dataset validation",
        description="Interface-only placeholder for converted dataset checks.",
        enabled=False,
        schema={},
    ),
]
