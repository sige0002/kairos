# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
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
import math
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path

from kairos_common import ApiError, ValidationTemplate

from dora_runner.bagflow_flow import DEFAULT_FLOW, list_flows
from dora_runner.bagflow_runtime import DoraEndpoint, bagflow_available
from dora_runner.clock_check import (
    DEFAULT_MAX_SAMPLES,
    DEFAULT_THRESHOLD_MS,
    run_clock_check,
)
from dora_runner.fast_validation import run_fast_validation
from dora_runner.full_validation import run_full_validation
from dora_runner.loss_report import run_loss_report
from dora_runner.loss_report_config import (
    LossReportConfig,
    load_loss_report_config,
)
from dora_runner.params_validation import validate_params_schema
from dora_runner.signal_report import DEFAULT_MAX_POINTS, run_signal_report
from dora_runner.store import JobRecord, RunnerStore
from dora_runner.validation import generate_template
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
    required_inputs: list[str] = field(default_factory=lambda: ["capture_id"])
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
        validate_params_schema(pipeline.params_schema)
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
    # If the caller omitted a template, use the capture itself as a draft baseline.
    return generate_template(job.capture_id, data_dir)


async def _run_fast_validation(
    job: JobRecord, store: RunnerStore, data_dir: Path
) -> dict:
    template = await _resolve_template(job, store, data_dir)
    job.progress = 0.4
    return await run_fast_validation(
        capture_id=job.capture_id,
        data_dir=data_dir,
        endpoint=DoraEndpoint.from_env(),
        # Naming the dataflow after the job is what makes cleanup targeted:
        # `dora stop --name <job_id>` can only ever reach this job's flow.
        job_name=job.job_id,
        template=template,
        cancel_event=job.cancel_event,
    )


async def _resolve_optional_template(
    job: JobRecord, store: RunnerStore
) -> ValidationTemplate | None:
    """Resolve a template for a pipeline where it is OPTIONAL (full_validation).

    Same inline/named resolution as ``_resolve_template``, but an omitted param
    yields ``None`` instead of a draft generated from the run itself: a flow that
    asks for ``${KAIROS_REQUIRED_TOPICS}`` then falls back to the recording
    config's required topics, and "every topic this run happens to contain" would
    make such a check vacuously true.
    """
    raw = job.params.get("template")
    if isinstance(raw, dict):
        return ValidationTemplate.model_validate(raw)
    if isinstance(raw, str) and raw:
        template = await store.get_template(raw)
        if template is not None:
            return template
        raise ApiError(
            status_code=400,
            code="template_not_found",
            message=f"Validation template not found: {raw}",
            details={"template": raw},
        )
    return None


def _flow_param(params: dict) -> str:
    """``flow`` job param: which ``config/<robot>/flows/<name>.yml`` to run."""
    raw = params.get("flow")
    if raw is None:
        return DEFAULT_FLOW
    if not isinstance(raw, str) or not raw.strip():
        raise ApiError(
            status_code=400,
            code="invalid_flow",
            message="flow must be a non-empty string.",
        )
    return raw.strip()


def _min_coverage_param(params: dict) -> float:
    """``min_coverage`` job param: 0-1 fraction of the bag a verdict must cover."""
    raw = params.get("min_coverage")
    if raw is None:
        return 0.0
    value = raw if isinstance(raw, (int, float)) and not isinstance(raw, bool) else -1
    if not 0.0 <= value <= 1.0:
        raise ApiError(
            status_code=400,
            code="invalid_min_coverage",
            message="min_coverage must be a number between 0 and 1.",
        )
    return value


async def _run_full_validation(
    job: JobRecord, store: RunnerStore, data_dir: Path
) -> dict:
    template = await _resolve_optional_template(job, store)
    job.progress = 0.3
    return await run_full_validation(
        capture_id=job.capture_id,
        data_dir=data_dir,
        flow=_flow_param(job.params),
        endpoint=DoraEndpoint.from_env(),
        # Naming the dataflow after the job is what makes cleanup targeted:
        # `dora stop --name <job_id>` can only ever reach this job's flow.
        job_name=job.job_id,
        template=template,
        min_coverage=_min_coverage_param(job.params),
        cancel_event=job.cancel_event,
    )


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
            list(target) if target is not None else list(config.target_topics)
        ),
        "gap_threshold_multiplier": (
            multiplier if multiplier is not None else config.gap_threshold_multiplier
        ),
    }


def _make_loss_report_runner(config: LossReportConfig) -> Runner:
    """Build a loss_report runner that injects *config*-driven params (OL-④.3)."""

    async def _run_loss_report(
        job: JobRecord, store: RunnerStore, data_dir: Path
    ) -> dict:
        kwargs = _loss_report_params(job.params, config)
        return await asyncio.to_thread(
            run_loss_report,
            capture_id=job.capture_id,
            data_dir=data_dir,
            cancel=job.cancel_event,
            **kwargs,
        )

    return _run_loss_report


def _threshold_ms_param(params: dict) -> float:
    """Optional ``threshold_ms`` job param: offset verdict threshold.

    Must be a FINITE number > 0: ``inf`` would silently disable every verdict
    AND make the summary unserialisable as strict JSON (a bare ``Infinity``
    token the browser rejects); a bool is a type confusion, not a number.
    """
    raw = params.get("threshold_ms")
    if raw is None:
        return DEFAULT_THRESHOLD_MS
    value = raw if isinstance(raw, (int, float)) and not isinstance(raw, bool) else 0
    if not math.isfinite(value) or value <= 0:
        raise ApiError(
            status_code=400,
            code="invalid_threshold_ms",
            message="threshold_ms must be a finite number > 0 (milliseconds).",
        )
    return value


# Decode-budget ceiling: far above any useful sample size, low enough that a
# fat-fingered value cannot turn the "bounded decode" into a full-bag one.
MAX_CLOCK_CHECK_SAMPLES = 100_000


def _max_samples_param(params: dict) -> int:
    """Optional ``max_samples_per_topic`` job param: decode budget per topic.

    An integral number in [10, MAX_CLOCK_CHECK_SAMPLES]; a fractional value is
    rejected (the schema says integer) rather than silently truncated.
    """
    raw = params.get("max_samples_per_topic")
    if raw is None:
        return DEFAULT_MAX_SAMPLES
    value = raw if isinstance(raw, int) and not isinstance(raw, bool) else 0
    if not 10 <= value <= MAX_CLOCK_CHECK_SAMPLES:
        raise ApiError(
            status_code=400,
            code="invalid_max_samples",
            message=(
                "max_samples_per_topic must be an integer between 10 and "
                f"{MAX_CLOCK_CHECK_SAMPLES}."
            ),
        )
    return value


async def _run_clock_check(job: JobRecord, store: RunnerStore, data_dir: Path) -> dict:
    target = job.params.get("target_topics")
    return await asyncio.to_thread(
        run_clock_check,
        capture_id=job.capture_id,
        data_dir=data_dir,
        threshold_ms=_threshold_ms_param(job.params),
        max_samples_per_topic=_max_samples_param(job.params),
        target_topics=list(target) if target is not None else None,
        cancel=job.cancel_event,
    )


def _max_frames_param(params: dict) -> int:
    """Optional ``max_frames`` job param: encode cap, ``0`` = the full episode."""
    raw = params.get("max_frames")
    if raw is None:
        return MAX_FRAMES
    value = raw if isinstance(raw, int) and not isinstance(raw, bool) else -1
    if value < 0:
        raise ApiError(
            status_code=400,
            code="invalid_max_frames",
            message="max_frames must be an integer >= 0 (0 = the full episode).",
        )
    return value


async def _run_video_check(job: JobRecord, store: RunnerStore, data_dir: Path) -> dict:
    topic = job.params.get("topic")
    if not isinstance(topic, str) or not topic.strip():
        raise ApiError(
            status_code=400,
            code="topic_required",
            message="video_check requires a camera 'topic' param.",
        )
    return await asyncio.to_thread(
        run_video_check,
        capture_id=job.capture_id,
        data_dir=data_dir,
        topic=topic,
        # Results are cached per (capture_id, topic); force=true re-encodes anyway.
        force=job.params.get("force", False),
        # Encode cap; 0 = full episode (the UI's "re-encode full" path).
        max_frames=_max_frames_param(job.params),
        cancel=job.cancel_event,
    )


def _topics_param(params: dict) -> list[str] | None:
    """Optional topic-name array; empty/absent means all numeric topics."""
    raw = params.get("topics")
    if raw is None:
        return None
    if not isinstance(raw, list) or any(not isinstance(item, str) for item in raw):
        raise ApiError(
            status_code=400,
            code="invalid_topics",
            message="topics must be an array of topic names.",
        )
    items = [item.strip() for item in raw]
    names = [name for name in items if name]
    return names or None


def _max_points_param(params: dict) -> int:
    """Optional ``max_points`` job param: per-topic downsample cap (>= 1)."""
    raw = params.get("max_points")
    if raw is None:
        return DEFAULT_MAX_POINTS
    value = raw if isinstance(raw, int) and not isinstance(raw, bool) else 0
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
        capture_id=job.capture_id,
        data_dir=data_dir,
        topics=_topics_param(job.params),
        max_points=_max_points_param(job.params),
        cancel=job.cancel_event,
    )


# ---- default registry ---------------------------------------------------------

_VALIDATION_TEMPLATE_OBJECT_SCHEMA = {
    "type": "object",
    "required": ["name", "version"],
    "additionalProperties": False,
    "properties": {
        "name": {"type": "string", "minLength": 1},
        "version": {"type": "integer", "minimum": 1},
        "required_topics": {
            "type": "array",
            "default": [],
            "items": {
                "type": "object",
                "required": ["name"],
                "additionalProperties": False,
                "properties": {
                    "name": {"type": "string", "minLength": 1},
                    "type": {"type": ["string", "null"]},
                },
            },
        },
    },
}
_FAST_VALIDATION_SCHEMA = {
    "type": "object",
    "required": ["template"],
    "additionalProperties": False,
    "properties": {
        "template": {
            # Browser/direct callers may use the catalog id.  The orchestrator
            # resolves that id to this strict object before forwarding so the
            # runner is independent of the orchestrator's local config tree.
            "oneOf": [
                {"type": "string", "minLength": 1},
                _VALIDATION_TEMPLATE_OBJECT_SCHEMA,
            ]
        }
    },
}
_VIDEO_CHECK_SCHEMA = {
    "type": "object",
    "required": ["topic"],
    "properties": {
        # x-suggest: the UI-agnostic form hint (dora_plugins.md §2.5) — the
        # generic PipelineForm offers the selected target run's camera topics
        # as a picker (seeding the first one) instead of a free-text box.
        # Plugins can use the same annotation ("camera_topics" | "topics").
        "topic": {"type": "string", "x-suggest": "camera_topics"},
        # Results are cached per (capture_id, topic); true re-encodes anyway.
        "force": {"type": "boolean", "default": False},
        # Encode cap: default keeps previews short; 0 = the full episode
        # (pair with force to regenerate a truncated preview at full length).
        "max_frames": {"type": "integer", "minimum": 0, "default": MAX_FRAMES},
    },
}
_CLOCK_CHECK_SCHEMA = {
    "type": "object",
    "properties": {
        "threshold_ms": {
            "type": "number",
            "title": "Offset threshold (ms)",
            "description": (
                "Flag a topic when |median(log_time - header.stamp)| exceeds "
                "this, or when the bag's head and tail disagree by more."
            ),
            "exclusiveMinimum": 0,
            "default": DEFAULT_THRESHOLD_MS,
        },
        "max_samples_per_topic": {
            "type": "integer",
            "title": "Samples per topic",
            "description": (
                "Decode budget per topic, split between a head and a tail "
                "window of the recording."
            ),
            "minimum": 10,
            "maximum": MAX_CLOCK_CHECK_SAMPLES,
            "default": DEFAULT_MAX_SAMPLES,
        },
        "target_topics": {
            "type": "array",
            "title": "Target topics",
            "description": "Glob patterns to restrict the check (empty = all topics).",
            "items": {"type": "string"},
            "default": [],
        },
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
    },
}


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
        },
    }


def full_validation_schema(flows: list[str]) -> dict:
    """``full_validation`` params. *flows* are the discovered flow files.

    The flow list becomes an ``enum`` so the auto-rendered form is a picker over
    what this robot actually ships (no free-text guessing); with no flows found
    it degrades to a text field rather than an empty, unselectable dropdown.
    """
    flow_property: dict = {
        "type": "string",
        "title": "Flow",
        "description": (
            "Validation flow from config/<robot>/flows/ (a bagflow flow.yml)."
        ),
        "default": DEFAULT_FLOW if DEFAULT_FLOW in flows or not flows else flows[0],
    }
    if flows:
        flow_property["enum"] = flows
    return {
        "type": "object",
        "properties": {
            "flow": flow_property,
            # Named `template` so the UI renders its catalog picker (a field with
            # this exact name is special-cased in PipelineForm); empty = the
            # active template (Settings -> Validation), injected by the orchestrator.
            "template": {
                "title": "Validation template",
                "description": (
                    "Supplies ${KAIROS_REQUIRED_TOPICS} to the flow; empty uses "
                    "the active template, then the recording config."
                ),
                "oneOf": [
                    {"type": "string"},
                    _VALIDATION_TEMPLATE_OBJECT_SCHEMA,
                ],
            },
            "min_coverage": {
                "type": "number",
                "title": "Minimum coverage",
                "description": (
                    "Fail when the least-covered edge saw less than this fraction "
                    "of the bag (0 = report coverage without gating)."
                ),
                "minimum": 0,
                "maximum": 1,
                "default": 0,
            },
        },
    }


# Interface-only placeholders (no runner yet): advertised so the registry/UI show
# the roadmap, but POST /jobs rejects them as not-implemented.
_PLACEHOLDERS = [
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


def _fast_validation_pipeline() -> RegisteredPipeline:
    """``fast_validation``: the required-topic gate, registered honestly.

    Since the port to bagflow it runs on dora like ``full_validation`` and needs
    the same bundled binaries, so it follows the same rule: where they are absent
    (a host checkout, CI, a hand-rolled deployment) the pipeline is advertised
    with the reason instead of accepting jobs that can only fail at execution
    time. Its flow ships with the service, so — unlike full_validation — there is
    nothing for the operator to author before it works.
    """
    available = bagflow_available()
    return RegisteredPipeline(
        id="fast_validation",
        name="Fast validation",
        description=(
            "Required-topic presence check for a capture's MCAP "
            "(bagflow flow on dora; reads the bag's metadata only)."
            if available
            else (
                "Unavailable here: needs the bagflow + dora binaries bundled in "
                "the dora_runner image."
            )
        ),
        params_schema=_FAST_VALIDATION_SCHEMA,
        outputs=["report/fast_validation/<capture_id>/summary.json"],
        executor="dora",
        runner=_run_fast_validation if available else None,
    )


def _full_validation_pipeline() -> RegisteredPipeline:
    """``full_validation``: the operator-authored flow gate, registered honestly.

    Like ``fast_validation`` it needs binaries the source tree does not carry
    (the bagflow CLI + node binaries + the dora daemon, all built into the
    dora_runner image), and additionally a flow to run: with no
    ``config/<robot>/flows/`` the ``flow`` enum has nothing to offer, so the form
    degrades to a text field rather than an empty dropdown.
    """
    available = bagflow_available()
    flows = list_flows() if available else []
    return RegisteredPipeline(
        id="full_validation",
        name="Full validation",
        description=(
            "Declarative post-recording gate: runs config/<robot>/flows/<flow>.yml "
            "on dora (decode/blur/brightness/freeze/stamp-gap/topic-rate)."
            if available
            else (
                "Unavailable here: needs the bagflow + dora binaries bundled in "
                "the dora_runner image."
            )
        ),
        params_schema=full_validation_schema(flows),
        outputs=["report/full_validation/<capture_id>/summary.json"],
        executor="dora",
        runner=_run_full_validation if available else None,
    )


def build_default_registry(
    loss_config: LossReportConfig | None = None,
    *,
    discover: bool = True,
    plugins_dir: Path | None = None,
) -> PipelineRegistry:
    """Construct the registry with the implemented pipelines + placeholders.

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
    registry.register(_fast_validation_pipeline())
    registry.register(_full_validation_pipeline())
    registry.register(
        RegisteredPipeline(
            id="loss_report",
            name="Loss report",
            description="Per-topic gap-based loss estimate from a capture's MCAP.",
            params_schema=loss_report_schema(config),
            outputs=["report/loss_report/<capture_id>/summary.json"],
            runner=_make_loss_report_runner(config),
        )
    )
    registry.register(
        RegisteredPipeline(
            id="clock_check",
            name="Clock check",
            description=(
                "Recorder-vs-publisher clock consistency: compares each "
                "message's header.stamp (publisher clock) to its MCAP "
                "log_time (recorder clock) and flags offsets and "
                "mid-recording clock steps."
            ),
            params_schema=_CLOCK_CHECK_SCHEMA,
            outputs=["report/clock_check/<capture_id>/summary.json"],
            runner=_run_clock_check,
        )
    )
    registry.register(
        RegisteredPipeline(
            id="video_check",
            name="Video check",
            description=(
                "On-demand mp4 preview of a camera topic from a capture's MCAP."
            ),
            params_schema=_VIDEO_CHECK_SCHEMA,
            outputs=["report/video_check/<capture_id>/<topic>.mp4"],
            runner=_run_video_check,
        )
    )
    registry.register(
        RegisteredPipeline(
            id="signal_report",
            name="Signal report",
            description=(
                "Generic numeric time-series + per-topic continuity from a "
                "capture's MCAP, for Review charts."
            ),
            params_schema=_SIGNAL_REPORT_SCHEMA,
            outputs=["report/signal_report/<capture_id>/summary.json"],
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
