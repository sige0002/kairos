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
from dora_runner.loss_report_config import (
    LossReportConfig,
    coerce_multiplier,
    coerce_target_topics,
    load_loss_report_config,
)
from dora_runner.signal_report import DEFAULT_MAX_POINTS, run_signal_report
from dora_runner.store import JobRecord, RunnerStore
from dora_runner.validation import generate_template, run_fast_validation
from dora_runner.video_check import MAX_FRAMES, run_video_check

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


def _dataset_dir_param(params: dict) -> str | None:
    """Optional ``dataset_dir`` job param (post-export source), ``None`` if unset."""
    raw = params.get("dataset_dir")
    return str(raw) if isinstance(raw, str) and raw.strip() else None


def _loss_report_params(params: dict, config: LossReportConfig) -> dict[str, object]:
    """Resolve loss_report kwargs from job params, falling back to *config*.

    A job param overrides the config default; an absent param uses the
    config-driven default (which itself falls back to the code default). Keeps
    behaviour unchanged when params are absent (OL-④.3).
    """
    target = params.get("target_topics")
    multiplier = params.get("gap_threshold_multiplier")
    return {
        "target_topics": (
            coerce_target_topics(target)
            if target is not None
            else list(config.target_topics)
        ),
        "gap_threshold_multiplier": (
            coerce_multiplier(multiplier)
            if multiplier is not None
            else config.gap_threshold_multiplier
        ),
        # Post-export source: read the exported dataset dir instead of
        # recorded/<run_id> (the recording was MOVED there by dataset_export).
        "dataset_dir": _dataset_dir_param(params),
    }


def _make_loss_report_runner(config: LossReportConfig) -> Runner:
    """Build a loss_report runner that injects *config*-driven params (OL-④.3)."""

    async def _run_loss_report(
        job: JobRecord, store: RunnerStore, data_dir: Path
    ) -> dict:
        kwargs = _loss_report_params(job.params, config)
        return await asyncio.to_thread(
            run_loss_report, run_id=job.run_id, data_dir=data_dir, **kwargs
        )

    return _run_loss_report


def _max_frames_param(params: dict) -> int:
    """Optional ``max_frames`` job param: encode cap, ``0`` = the full episode."""
    raw = params.get("max_frames")
    if raw is None:
        return MAX_FRAMES
    try:
        value = int(raw)
    except (TypeError, ValueError):
        value = -1
    if value < 0:
        raise ApiError(
            status_code=400,
            code="invalid_max_frames",
            message="max_frames must be an integer >= 0 (0 = the full episode).",
        )
    return value


async def _run_video_check(job: JobRecord, store: RunnerStore, data_dir: Path) -> dict:
    topic = job.params.get("topic")
    if not topic or not str(topic).strip():
        raise ApiError(
            status_code=400,
            code="topic_required",
            message="video_check requires a camera 'topic' param.",
        )
    return await asyncio.to_thread(
        run_video_check,
        run_id=job.run_id,
        data_dir=data_dir,
        topic=str(topic),
        # Results are cached per (run_id, topic); force=true re-encodes anyway.
        force=bool(job.params.get("force")),
        # Post-export source: read the exported dataset dir instead of
        # recorded/<run_id> (the recording was MOVED there by dataset_export).
        dataset_dir=_dataset_dir_param(job.params),
        # Encode cap; 0 = full episode (the UI's "re-encode full" path).
        max_frames=_max_frames_param(job.params),
    )


def _topics_param(params: dict) -> list[str] | None:
    """Optional ``topics`` allow-list: list or comma-string, ``None`` = all.

    Accepts the frontend's array of topic names or a comma-separated string
    (CLI convenience); blank entries are dropped. An empty/absent value returns
    ``None``, which signal_report reads as "every non-image numeric topic".
    """
    raw = params.get("topics")
    if raw is None:
        return None
    if isinstance(raw, str):
        items = [part.strip() for part in raw.split(",")]
    elif isinstance(raw, (list, tuple)):
        items = [str(part).strip() for part in raw]
    else:
        raise ApiError(
            status_code=400,
            code="invalid_topics",
            message="topics must be a list of topic names (or a comma string).",
        )
    names = [name for name in items if name]
    return names or None


def _max_points_param(params: dict) -> int:
    """Optional ``max_points`` job param: per-topic downsample cap (>= 1)."""
    raw = params.get("max_points")
    if raw is None:
        return DEFAULT_MAX_POINTS
    try:
        value = int(raw)
    except (TypeError, ValueError):
        value = 0
    if value < 1:
        raise ApiError(
            status_code=400,
            code="invalid_max_points",
            message="max_points must be an integer >= 1.",
        )
    return value


async def _run_signal_report(
    job: JobRecord, store: RunnerStore, data_dir: Path
) -> dict:
    return await asyncio.to_thread(
        run_signal_report,
        run_id=job.run_id,
        data_dir=data_dir,
        topics=_topics_param(job.params),
        max_points=_max_points_param(job.params),
        # Post-export source: read the exported dataset dir instead of
        # recorded/<run_id> (the recording was MOVED there by dataset_export).
        dataset_dir=_dataset_dir_param(job.params),
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
    "properties": {
        "topic": {"type": "string"},
        # Results are cached per (run_id, topic); true re-encodes anyway.
        "force": {"type": "boolean", "default": False},
        # Post-export source: "<operator>/<task>/<NNN>" under data/ (the
        # exported dataset dir); omitted = read recorded/<run_id>.
        "dataset_dir": {"type": "string"},
        # Encode cap: default keeps previews short; 0 = the full episode
        # (pair with force to regenerate a truncated preview at full length).
        "max_frames": {"type": "integer", "minimum": 0, "default": MAX_FRAMES},
    },
}
_SIGNAL_REPORT_SCHEMA = {
    "type": "object",
    "properties": {
        "topics": {
            "type": "array",
            "title": "Topics",
            "description": (
                "Topics to extract (empty = every non-image topic with numeric "
                "fields). Image topics use video_check instead."
            ),
            "items": {"type": "string"},
        },
        "max_points": {
            "type": "integer",
            "title": "Max points per topic",
            "description": "Uniform-stride downsample cap per topic.",
            "minimum": 1,
            "default": DEFAULT_MAX_POINTS,
        },
        # Post-export source: "<operator>/<task>/<NNN>" under data/ (the
        # exported dataset dir); omitted = read recorded/<run_id>.
        "dataset_dir": {"type": "string"},
    },
}
_NO_PARAMS_SCHEMA = {"type": "object", "properties": {}}


def loss_report_schema(config: LossReportConfig) -> dict:
    """Build loss_report's params_schema with *config*-driven defaults (OL-④.3).

    The defaults are echoed as JSON-Schema ``default`` values so the
    orchestrator/frontend auto-form seeds the controls; an empty
    ``target_topics`` means "every topic" (the original behaviour).
    """
    return {
        "type": "object",
        "properties": {
            "target_topics": {
                "type": "array",
                "title": "Target topics",
                "description": (
                    "Glob patterns to restrict the report (empty = all topics)."
                ),
                "items": {"type": "string"},
                "default": list(config.target_topics),
            },
            "gap_threshold_multiplier": {
                "type": "number",
                "title": "Gap threshold multiplier",
                "description": (
                    "Flag a topic when its worst gap exceeds "
                    "median_interval_ms * this multiplier."
                ),
                # exclusiveMinimum (not minimum): coerce_multiplier rejects 0 and
                # negatives back to the default, so the advertised contract must
                # forbid them too (no silent value substitution).
                "exclusiveMinimum": 0,
                "default": config.gap_threshold_multiplier,
            },
            "dataset_dir": {
                "type": "string",
                "title": "Dataset directory",
                "description": (
                    "Post-export source: <operator>/<task>/<NNN> under data/; "
                    "omitted = read recorded/<run_id>."
                ),
            },
        },
    }


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


def build_default_registry(
    loss_config: LossReportConfig | None = None,
    *,
    discover: bool = True,
    plugins_dir: Path | None = None,
) -> PipelineRegistry:
    """Construct the registry with the four implemented pipelines + placeholders.

    *loss_config* supplies loss_report's config-driven defaults (OL-④.3); it
    defaults to loading ``config/<robot>/validators/loss_report.yaml`` (env
    ``LOSS_REPORT_CONFIG``), falling back to code defaults when absent.

    When *discover* is true, drop-in plugins under *plugins_dir* (default
    ``KAIROS_PLUGINS_DIR`` / the in-tree ``plugins/``) are scanned and registered
    too (see ``plugin_loader.discover_plugins``). A broken plugin is skipped, not
    fatal. Pass ``discover=False`` for hermetic unit tests of the bundled set.
    """
    config = loss_config or load_loss_report_config()
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
                "MOVE a recorded run into data/<operator>/<task>/<NNN> (from "
                "session.json); the recording leaves recorded/ after export."
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
            params_schema=loss_report_schema(config),
            outputs=["report/loss_report/<run_id>/summary.json"],
            runner=_make_loss_report_runner(config),
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
    registry.register(
        RegisteredPipeline(
            id="signal_report",
            name="Signal report",
            description=(
                "Generic numeric time-series + per-topic continuity from a "
                "recorded MCAP, for Review charts."
            ),
            params_schema=_SIGNAL_REPORT_SCHEMA,
            outputs=["report/signal_report/<run_id>/summary.json"],
            runner=_run_signal_report,
        )
    )
    for pid, name, description in _PLACEHOLDERS:
        registry.register(
            RegisteredPipeline(
                id=pid, name=name, description=description, params_schema={}
            )
        )
    if discover:
        # Local import avoids a cycle: plugin_loader imports names from this module.
        from dora_runner.plugin_loader import default_plugins_dir, discover_plugins

        discover_plugins(registry, plugins_dir or default_plugins_dir())
    return registry


DEFAULT_REGISTRY = build_default_registry()
