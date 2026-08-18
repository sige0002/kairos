# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Durable, server-owned Validation Run contracts.

A run groups several independent dora jobs. It is deliberately separate from a
pipeline result: ``finished`` means every child reached an honest outcome, not
that validation passed.
"""

from __future__ import annotations

from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field, model_validator

from api_orchestrator.models import JobResult, JobStatus

ValidationRunState = Literal["creating", "running", "cancel_requested", "finished"]
DispatchState = Literal[
    "pending_lease",
    "submitting",
    "accepted",
    "submission_failed",
    "canceled_before_submit",
]


class ValidationRunCreateRequest(BaseModel):
    pipeline: str = Field(min_length=1, max_length=128)
    capture_ids: list[str] | None = Field(default=None, min_length=1, max_length=1000)
    selection_id: str | None = Field(default=None, min_length=1, max_length=256)
    params: dict[str, Any] = Field(default_factory=dict)
    # A caller-generated UUID makes a response-loss retry an idempotent create,
    # rather than a second durable validation intent.
    request_id: UUID

    @model_validator(mode="after")
    def _one_target_source(self) -> ValidationRunCreateRequest:
        if (self.capture_ids is None) == (self.selection_id is None):
            raise ValueError("provide exactly one of capture_ids or selection_id")
        return self


class ValidationRunJob(BaseModel):
    run_job_id: str
    capture_id: str
    attempt: int
    dispatch_state: DispatchState
    job: JobStatus | None = None
    failure_code: str | None = None
    failure_message: str | None = None
    result: JobResult | None = None


class ValidationRun(BaseModel):
    run_id: str
    pipeline: str
    params: dict[str, Any] = Field(default_factory=dict)
    selection_id: str | None = None
    state: ValidationRunState
    cancel_requested: bool = False
    created_at: str
    updated_at: str
    completed_at: str | None = None
    jobs: list[ValidationRunJob] = Field(default_factory=list)


class ValidationRunListResponse(BaseModel):
    items: list[ValidationRun] = Field(default_factory=list)
