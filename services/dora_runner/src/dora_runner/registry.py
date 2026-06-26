"""Pipeline registry: metadata + runnable adapters for dora_runner (OL-④).

Replaces the static ``PIPELINES`` list and the ``if/elif job.pipeline == ...``
dispatch in ``main.py`` with a single registry. Each pipeline carries its
metadata (id / name / description / params_schema / required_inputs / outputs /
executor) AND a uniform async runner ``(job, store, data_dir) -> dict`` — so
adding a pipeline is one registration, and the frontend renders its form from
``params_schema`` with no UI edit.

``executor`` is ``in_process`` today (a pure function run in a worker thread); the
registry is shaped so a pipeline can later map to a dora node / dataflow without
touching the call sites — the "in-process node contract → registry → dora-ready"
path, not "dora implemented".
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path

from kairos_common import ApiError, ValidationTemplate

from dora_runner.dataset_export import run_dataset_export
from dora_runner.loss_report import run_loss_report
from dora_runner.store import JobRecord, RunnerStore
from dora_runner.validation import generate_template, run_fast_validation
from dora_runner.video_check import run_video_check

# A pipeline runner: takes the job + shared store + data root, returns the raw
# result dict (validated as JobResult by the worker). May raise ApiError for a
# bad request (e.g. a missing param), which the worker records as a failure.
Runner = Callable[[JobRecord, RunnerStore, Path], Awaitable[dict]]


@dataclass(frozen=True)
class RegisteredPipeline:
    """One pipeline: metadata + (optional) runnable adapter."""

    id: str
    name: str
    description: str
    params_schema: dict
    required_inputs: list[str] = field(default_factory=lambda: ["run_id"])
    outputs: list[str] = field(default_factory=list)
    executor: str = "in_process"
    # None => interface-only placeholder (advertised but not runnable yet).
    runner: Runner | None = None

    @property
    def enabled(self) -> bool:
        return self.runner is not None


class PipelineRegistry:
    """Holds the registered pipelines; the single source for metadata + dispatch."""

    def __init__(self) -> None:
        self._items: dict[str, RegisteredPipeline] = {}

    def register(self, pipeline: RegisteredPipeline) -> None:
        self._items[pipeline.id] = pipeline

    def get(self, pipeline_id: str) -> RegisteredPipeline | None:
        return self._items.get(pipeline_id)

    def all(self) -> list[RegisteredPipeline]:
        return list(self._items.values())

    def runnable(self, pipeline_id: str) -> bool:
        """Whether *pipeline_id* exists and has a runner (not a placeholder)."""
        pipeline = self._items.get(pipeline_id)
        return pipeline is not None and pipeline.runner is not None


# ---- runner adapters (uniform signature over the pure pipeline functions) -----


async def _resolve_template(
    job: JobRecord, store: RunnerStore, data_dir: Path
) -> ValidationTemplate:
    """Resolve a fast_validation template from job params (inline / named / draft)."""
    raw = job.params.get("template")
    if isinstance(raw, dict):
        return ValidationTemplate.model_validate(raw)
    if isinstance(raw, str):
        template = await store.get_template(raw)
        if template is not None:
            return template
        raise ApiError(
            status_code=400,
            code="template_not_found",
            message=f"Validation template not found: {raw}",
            details={"template": raw},
        )
    # If the caller omitted a template, use the run itself as a draft baseline.
    return generate_template(job.run_id, data_dir)


async def _run_fast_validation(
    job: JobRecord, store: RunnerStore, data_dir: Path
) -> dict:
    template = await _resolve_template(job, store, data_dir)
    job.progress = 0.4
    return await asyncio.to_thread(
        run_fast_validation, run_id=job.run_id, data_dir=data_dir, template=template
    )


async def _run_dataset_export(
    job: JobRecord, store: RunnerStore, data_dir: Path
) -> dict:
    return await asyncio.to_thread(
        run_dataset_export, run_id=job.run_id, data_dir=data_dir
    )


async def _run_loss_report(job: JobRecord, store: RunnerStore, data_dir: Path) -> dict:
    return await asyncio.to_thread(
        run_loss_report, run_id=job.run_id, data_dir=data_dir
    )


async def _run_video_check(job: JobRecord, store: RunnerStore, data_dir: Path) -> dict:
    topic = job.params.get("topic")
    if not topic or not str(topic).strip():
        raise ApiError(
            status_code=400,
            code="topic_required",
            message="video_check requires a camera 'topic' param.",
        )
    return await asyncio.to_thread(
        run_video_check, run_id=job.run_id, data_dir=data_dir, topic=str(topic)
    )


# ---- default registry ---------------------------------------------------------

_FAST_VALIDATION_SCHEMA = {
    "type": "object",
    "required": ["template"],
    "properties": {"template": {"type": "string"}},
}
_VIDEO_CHECK_SCHEMA = {
    "type": "object",
    "required": ["topic"],
    "properties": {"topic": {"type": "string"}},
}
_NO_PARAMS_SCHEMA = {"type": "object", "properties": {}}

# Interface-only placeholders (no runner yet): advertised so the registry/UI show
# the roadmap, but POST /jobs rejects them as not-implemented.
_PLACEHOLDERS = [
    (
        "full_validation",
        "Full validation",
        "Interface-only placeholder for deeper validation.",
    ),
    (
        "dataset_convert",
        "Dataset conversion",
        "Interface-only placeholder for format conversion (LeRobot/RLDS).",
    ),
    (
        "dataset_validation",
        "Dataset validation",
        "Interface-only placeholder for converted dataset checks.",
    ),
]


def build_default_registry() -> PipelineRegistry:
    """Construct the registry with the four implemented pipelines + placeholders."""
    registry = PipelineRegistry()
    registry.register(
        RegisteredPipeline(
            id="fast_validation",
            name="Fast validation",
            description="Required-topic presence check for recorded MCAP runs.",
            params_schema=_FAST_VALIDATION_SCHEMA,
            outputs=["report/fast_validation/<run_id>/summary.json"],
            runner=_run_fast_validation,
        )
    )
    registry.register(
        RegisteredPipeline(
            id="dataset_export",
            name="Dataset export",
            description=(
                "Copy a recorded run into data/<operator>/<task>/<NNN> (from "
                "session.json). Read-only on the canonical recording."
            ),
            params_schema=_NO_PARAMS_SCHEMA,
            outputs=["data/<operator>/<task>/<NNN>/"],
            runner=_run_dataset_export,
        )
    )
    registry.register(
        RegisteredPipeline(
            id="loss_report",
            name="Loss report",
            description="Per-topic gap-based loss estimate from a recorded MCAP.",
            params_schema=_NO_PARAMS_SCHEMA,
            outputs=["report/loss_report/<run_id>/summary.json"],
            runner=_run_loss_report,
        )
    )
    registry.register(
        RegisteredPipeline(
            id="video_check",
            name="Video check",
            description="On-demand mp4 preview of a camera topic from a recorded MCAP.",
            params_schema=_VIDEO_CHECK_SCHEMA,
            outputs=["report/video_check/<run_id>/<topic>.mp4"],
            runner=_run_video_check,
        )
    )
    for pid, name, description in _PLACEHOLDERS:
        registry.register(
            RegisteredPipeline(
                id=pid, name=name, description=description, params_schema={}
            )
        )
    return registry


DEFAULT_REGISTRY = build_default_registry()
