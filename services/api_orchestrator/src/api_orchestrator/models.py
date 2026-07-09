"""Pydantic models and shared enums for the api_orchestrator run lifecycle.

These mirror the schemas in ``docs/specs/ja/api_orchestrator.md`` and the
shared vocabulary in ``docs/specs/ja/config.md`` (run state enum, QoS, error
shape). They are the OpenAPI-visible request/response contracts for the public
``/api/v1`` run-lifecycle endpoints.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Any, Literal

from kairos_common import Compression, Durability, JobState, Reliability
from pydantic import BaseModel, Field


class RunState(StrEnum):
    """Run lifecycle state (shared vocabulary, config.md).

    Orchestrator owns this enum; recorder reports a compatible subset.
    """

    created = "created"
    recording = "recording"
    stopping = "stopping"
    completed = "completed"
    failed = "failed"
    interrupted = "interrupted"


class TopicQos(BaseModel):
    """Resolved per-topic QoS as recorded for a run."""

    reliability: Reliability
    durability: Durability
    depth: int = Field(ge=0)


class RunTopic(BaseModel):
    """A topic captured in a run, with its resolved type and QoS.

    Sourced from the recorder ``GET /record/metadata`` (the ``"all"`` selector
    is expanded there); the orchestrator only syncs it into the run row.
    """

    name: str
    type: str
    qos: TopicQos | None = None


class Split(BaseModel):
    """rosbag2 split configuration (size and/or duration)."""

    max_size_mb: int | None = None
    max_duration_s: int | None = None


class RunError(BaseModel):
    """Structured reason attached to a run (e.g. a failed start)."""

    code: str
    message: str


class Run(BaseModel):
    """A run as returned by ``GET /api/v1/runs/{id}`` and the record endpoints."""

    run_id: str
    state: RunState
    started_at: str | None = None
    ended_at: str | None = None
    topics: list[RunTopic] = Field(default_factory=list)
    compression: Compression = Compression.none
    split: Split | None = None
    message_count: int | None = None
    bytes: int | None = None
    error: RunError | None = None
    # Session metadata captured at record start (who recorded, what task).
    operator: str | None = None
    task: str | None = None


class RecordStartRequest(BaseModel):
    """Body for ``POST /api/v1/record/start``.

    ``topics`` may be an explicit list or the literal ``"all"``; when omitted,
    the orchestrator falls back to ``recording.yaml`` ``default_topics``.
    """

    topics: list[str] | Literal["all"] | None = None
    compression: Compression = Compression.none
    split: Split | None = None
    qos_default: TopicQos | None = None
    qos_overrides: dict[str, TopicQos] | None = None
    # Optional session metadata, persisted on the run and written to the run's
    # session.json sidecar (who collected the data, and the task being recorded).
    operator: str | None = None
    task: str | None = None


class RecordPrepareResponse(BaseModel):
    """Response for ``POST /api/v1/record/prepare`` (two-phase start).

    No ``Run`` row exists yet at this point — prepare state lives only in
    memory on the orchestrator (``RunService._prepared``) until a matching
    ``POST /api/v1/record/start`` actually persists a row — so this is a
    distinct shape from :class:`Run`, not a partial/optional-field version of
    it. ``arming`` is a permissive pass-through of the recorder's readiness
    snapshot (matched/missing topics, etc.) rather than a tightly-coupled
    submodel, so a minor field-name difference on the recorder side does not
    hard-fail this response.
    """

    run_id: str
    state: Literal["armed"] = "armed"
    arming: dict[str, Any] = Field(default_factory=dict)
    disarm_at: str | None = None


class RunDetail(Run):
    """A single run plus on-disk audit/report sidecars (``GET /runs/{id}``).

    The base ``Run`` is the SQLite source of truth; these extra fields are read
    best-effort from disk when present (absent -> ``null``):
    - ``manifest``: the recorder's ``recorded/<run_id>/manifest.json`` audit.
    - ``validation``: the latest ``fast_validation`` report summary.
    - ``dataset_stats``: the latest ``dataset_export`` report summary.
    - ``loss``: the latest ``loss_report`` per-topic loss summary.
    """

    manifest: dict[str, Any] | None = None
    validation: dict[str, Any] | None = None
    dataset_stats: dict[str, Any] | None = None
    loss: dict[str, Any] | None = None


class RunListResponse(BaseModel):
    """Cursor-paginated run list (``GET /api/v1/runs``)."""

    items: list[Run]
    next_cursor: str | None = None


class DatasetDetail(BaseModel):
    """One exported dataset dir + its on-disk sidecars.

    (``GET /api/v1/datasets/{operator}/{task}/{index}``) — the post-export
    counterpart of :class:`RunDetail`. The run row is deleted on export, so
    everything here is read best-effort from the dataset directory
    (``dataset.json`` / ``session.json`` / ``manifest.json``) plus the
    run-keyed report sidecars that survive export, letting the Datasets tab
    show the same inspection view as Recordings (absent -> ``null``).
    """

    operator: str
    task: str
    index: str
    # Relative "<operator>/<task>/<index>" under data_dir — pass this as the
    # `dataset_dir` job param for post-export video_check / loss_report.
    path: str
    dataset_dir: str
    run_id: str | None = None
    state: str | None = None
    started_at: str | None = None
    ended_at: str | None = None
    exported_at: str | None = None
    bytes: int | None = None
    message_count: int | None = None
    files: list[str] = Field(default_factory=list)
    # From manifest.json when present (name+type+QoS); else the name-only list
    # from session.json / dataset.json (type == "").
    topics: list[RunTopic] = Field(default_factory=list)
    manifest: dict[str, Any] | None = None
    dataset: dict[str, Any] | None = None
    validation: dict[str, Any] | None = None
    loss: dict[str, Any] | None = None


class PipelineDefinition(BaseModel):
    """Pipeline entry surfaced by dora_runner."""

    id: str
    name: str
    description: str | None = None
    enabled: bool = True
    schema_: dict[str, Any] = Field(default_factory=dict, alias="schema")


class JobCreateRequest(BaseModel):
    """Body for ``POST /api/v1/jobs``."""

    run_id: str
    pipeline: str
    params: dict[str, Any] = Field(default_factory=dict)


class JobCreateResponse(BaseModel):
    """Response returned after creating a pipeline job."""

    job_id: str
    run_id: str
    pipeline: str
    state: JobState
    progress: float = Field(default=0.0, ge=0.0, le=1.0)
    logs_tail: list[str] = Field(default_factory=list)


class JobStatus(BaseModel):
    """OpenAPI-visible job status contract."""

    job_id: str
    run_id: str
    pipeline: str
    state: JobState
    progress: float = Field(ge=0.0, le=1.0)
    logs_tail: list[str] = Field(default_factory=list)


class JobResult(BaseModel):
    """Terminal job result."""

    summary: dict[str, Any]
    artifacts: list[str] = Field(default_factory=list)


class RequiredTopicTemplate(BaseModel):
    """Required topic entry in a validation template."""

    name: str
    type: str | None = None


class ValidationTemplate(BaseModel):
    """Validation template schema from api_orchestrator.md."""

    name: str
    version: int
    required_topics: list[RequiredTopicTemplate] = Field(default_factory=list)


class ValidationTemplateListResponse(BaseModel):
    """Cursor-paginated validation template list."""

    items: list[ValidationTemplate]
    next_cursor: str | None = None


class TemplateGenerateRequest(BaseModel):
    """Body for ``POST /api/v1/validation/templates/generate``."""

    run_id: str


class ValidationPresetInfo(BaseModel):
    """A one-click validation preset plus its live not-yet-validated targets.

    (``GET /api/v1/validation/presets``) The static fields (``id`` / ``name`` /
    ``description`` / ``pipeline`` / ``params``) come from the active robot's
    ``validation_presets.yaml``; the dynamic ones are computed per request:
    ``total`` completed recordings eligible, of which ``pending`` (listed in
    ``pending_run_ids``) have no report for this preset's pipeline yet. The
    Validation tab runs the preset over ``pending_run_ids`` with a single click.
    """

    id: str
    name: str
    description: str = ""
    pipeline: str
    params: dict[str, Any] = Field(default_factory=dict)
    total: int
    pending: int
    pending_run_ids: list[str] = Field(default_factory=list)


class ValidationPresetListResponse(BaseModel):
    """List of one-click validation presets (``GET /api/v1/validation/presets``)."""

    items: list[ValidationPresetInfo] = Field(default_factory=list)
