"""The job and validation-template models shared by orchestrator and dora_runner.

The orchestrator's ``/api/v1/jobs`` is a proxy: it forwards to dora_runner's
``/jobs`` and hands the answer back, so the two services were maintaining
identical model pairs by hand. Anything that has to survive that round trip
belongs here.

``JobCreateResponse`` deliberately does **not**: the two services mean different
things by it. dora_runner answers a create with ``{job_id}`` alone, while the
orchestrator parses dora_runner's *status* body into its own richer
``JobCreateResponse`` so a newly created job can be published on the event
stream. Merging them would either make fields required that dora_runner never
sends, or drop fields the orchestrator's SSE payload depends on.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from kairos_common.states import JobState


class RequiredTopicTemplate(BaseModel):
    """Required topic entry in a validation template."""

    name: str
    type: str | None = None


class ValidationTemplate(BaseModel):
    """Validation template schema (api_orchestrator.md), used by ``fast_validation``."""

    name: str
    version: int
    required_topics: list[RequiredTopicTemplate] = Field(default_factory=list)


class ValidationTemplateListResponse(BaseModel):
    """Cursor-paginated validation template list."""

    items: list[ValidationTemplate]
    next_cursor: str | None = None


class TemplateGenerateRequest(BaseModel):
    """Body for template generation (``POST /api/v1/validation/templates/generate``)."""

    capture_id: str


class JobCreateRequest(BaseModel):
    """Body for ``POST /api/v1/jobs`` (dora_runner: ``POST /jobs``).

    Keyed by ``capture_id`` (§10.5): every job resolves its source as
    ``objects/<capture_id>`` and writes to ``report/<pipeline>/<capture_id>/``.
    """

    capture_id: str
    pipeline: str
    params: dict[str, Any] = Field(default_factory=dict)


class JobStatus(BaseModel):
    """OpenAPI-visible job status contract."""

    job_id: str
    capture_id: str
    pipeline: str
    state: JobState
    progress: float = Field(ge=0.0, le=1.0)
    logs_tail: list[str] = Field(default_factory=list)


class JobResult(BaseModel):
    """Terminal job result."""

    summary: dict[str, Any]
    artifacts: list[str] = Field(default_factory=list)
