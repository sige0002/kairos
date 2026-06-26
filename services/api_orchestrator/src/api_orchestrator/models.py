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
