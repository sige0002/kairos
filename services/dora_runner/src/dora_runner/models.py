# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""HTTP and internal models for dora_runner."""

from __future__ import annotations

from typing import Any

# Re-exported, not redefined: the orchestrator proxies this service's job API,
# so these models live in kairos_common.contracts and both sides import one
# definition. Every existing ``from dora_runner.models import JobStatus`` keeps
# working. ``JobCreateResponse`` stays local — see the contracts docstring.
from kairos_common.contracts.jobs import (  # noqa: F401
    JobCreateRequest,
    JobResult,
    JobStatus,
    RequiredTopicTemplate,
    TemplateGenerateRequest,
    ValidationTemplate,
    ValidationTemplateListResponse,
)
from pydantic import BaseModel, Field


class JobCanceled(Exception):
    """Raised by a worker that stopped at a cancellation checkpoint.

    Cancelling a running job is cooperative: the API sets the job's
    ``cancel_event`` and the work raises this at its next checkpoint — a frame
    boundary, a per-topic step, or the bagflow subprocess watcher killing the
    CLI. ``main._execute_job`` catches it and records the job ``canceled`` at
    the moment the work is genuinely dead, never before.
    """


class JobCreateResponse(BaseModel):
    """Minimal job-create response.

    Not the orchestrator's model of the same name: that one carries the full
    status shape so a created job can be published on its event stream, while
    this answers a create with the id alone.
    """

    job_id: str


class PipelineDefinition(BaseModel):
    """Pipeline registry entry (metadata surfaced by ``GET /pipelines``).

    ``schema`` is the params JSON Schema the frontend renders a form from
    (OL-④.2). ``required_inputs`` / ``outputs`` describe the data contract.
    ``executor`` is the DECLARED execution target (``in_process`` today, or
    ``dora`` for a dataflow plugin); ``effective_executor`` is how it ACTUALLY
    runs here — a ``dora`` pipeline falls back to ``in-process`` when the dora
    CLI is absent, so the UI isn't misled into thinking dora is bundled.
    """

    id: str
    name: str
    description: str
    enabled: bool
    schema_: dict[str, Any] = Field(default_factory=dict, alias="schema")
    required_inputs: list[str] = Field(default_factory=lambda: ["capture_id"])
    outputs: list[str] = Field(default_factory=list)
    executor: str = "in_process"
    effective_executor: str = "in-process"
