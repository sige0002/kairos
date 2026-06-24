"""HTTP and internal models for dora_runner."""

from __future__ import annotations

from typing import Any

from kairos_common import JobState
from pydantic import BaseModel, Field


class RequiredTopicTemplate(BaseModel):
    """Required topic entry in a validation template."""

    name: str
    type: str | None = None


class ValidationTemplate(BaseModel):
    """Validation template used by ``fast_validation``."""

    name: str
    version: int
    required_topics: list[RequiredTopicTemplate] = Field(default_factory=list)


class ValidationTemplateListResponse(BaseModel):
    """Cursor-paginated template list."""

    items: list[ValidationTemplate]
    next_cursor: str | None = None


class TemplateGenerateRequest(BaseModel):
    """Body for template generation."""

    run_id: str


class JobCreateRequest(BaseModel):
    """Body for ``POST /jobs``."""

    run_id: str
    pipeline: str
    params: dict[str, Any] = Field(default_factory=dict)


class JobCreateResponse(BaseModel):
    """Minimal job-create response."""

    job_id: str


class JobStatus(BaseModel):
    """Job status response."""

    job_id: str
    run_id: str
    pipeline: str
    state: JobState
    progress: float = Field(ge=0.0, le=1.0)
    logs_tail: list[str] = Field(default_factory=list)


class JobResult(BaseModel):
    """Terminal job result response."""

    summary: dict[str, Any]
    artifacts: list[str] = Field(default_factory=list)


class PipelineDefinition(BaseModel):
    """Pipeline registry entry."""

    id: str
    name: str
    description: str
    enabled: bool
    schema_: dict[str, Any] = Field(default_factory=dict, alias="schema")
