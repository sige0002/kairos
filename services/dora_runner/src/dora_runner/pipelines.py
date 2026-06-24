"""Pipeline registry."""

from __future__ import annotations

from dora_runner.models import PipelineDefinition

FAST_VALIDATION_SCHEMA = {
    "type": "object",
    "required": ["template"],
    "properties": {"template": {"type": "string"}},
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
        id="full_validation",
        name="Full validation",
        description="Interface-only placeholder for deeper validation.",
        enabled=False,
        schema={},
    ),
    PipelineDefinition(
        id="dataset_convert",
        name="Dataset conversion",
        description="Interface-only placeholder for dataset conversion.",
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
