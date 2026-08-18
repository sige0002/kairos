# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Shared plan catalog (Projects -> Tasks -> Conditions) — ``/api/v1/plans``.

The catalog is the label VOCABULARY Collect stamps onto batches and episodes
(``project`` / ``task`` / ``condition``), plus the ``failure_reasons`` list
Collect offers when an episode is marked Failure. Serving it from the
orchestrator puts every terminal on ONE vocabulary — with the previous
browser-local copies, two laptops could label the same physical condition with
different strings, quietly fragmenting the exported labels (fixed vocabulary
is what makes labels aggregable).

This is deliberately NOT the Phase 2.5 Plan model: no batch references or
per-plan targets. Batches still store their stamped labels as plain strings.
Catalog entities do carry stable IDs so a rename does not make a browser lose
its selected item, and a whole-catalog revision prevents a second terminal
from silently overwriting an edit it did not read.
"""

from __future__ import annotations

import unicodedata

from fastapi import APIRouter, Request
from kairos_common import ApiError, utc_now_iso8601
from pydantic import BaseModel, Field, field_validator, model_validator

from api_orchestrator.store import CaptureStore, PlanCatalogConflictError

router = APIRouter(prefix="/api/v1/plans", tags=["plans"])


def _label(value: str) -> str:
    """Canonicalize a catalog label before it becomes shared vocabulary."""
    normalized = unicodedata.normalize("NFC", value).strip()
    if not normalized:
        raise ValueError("catalog labels cannot be blank")
    # The Console uses this as its visible no-plan sentinel. Persisting it as a
    # real item makes a missing value look like a selected vocabulary value.
    if normalized == "—":
        raise ValueError("catalog labels cannot be the reserved no-plan marker")
    if len(normalized) > 200:
        raise ValueError("catalog labels cannot exceed 200 characters")
    return normalized


def _entity_id(value: str) -> str:
    normalized = value.strip()
    if not normalized:
        raise ValueError("catalog IDs cannot be blank")
    return normalized


class PlanCondition(BaseModel):
    """One selectable condition with identity independent of its name."""

    condition_id: str = Field(
        min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$"
    )
    name: str = Field(max_length=200)

    _normalize_id = field_validator("condition_id")(_entity_id)
    _normalize_name = field_validator("name")(_label)


class PlanTask(BaseModel):
    """One task and the fixed conditions it may be recorded under."""

    task_id: str = Field(
        min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$"
    )
    name: str = Field(max_length=200)
    conditions: list[PlanCondition] = Field(default_factory=list)

    _normalize_id = field_validator("task_id")(_entity_id)
    _normalize_name = field_validator("name")(_label)

    @model_validator(mode="after")
    def _unique_conditions(self) -> PlanTask:
        _reject_duplicates(self.conditions, "condition")
        return self


class PlanProject(BaseModel):
    """One project grouping its tasks."""

    project_id: str = Field(
        min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$"
    )
    name: str = Field(max_length=200)
    tasks: list[PlanTask] = Field(default_factory=list)

    _normalize_id = field_validator("project_id")(_entity_id)
    _normalize_name = field_validator("name")(_label)

    @model_validator(mode="after")
    def _unique_tasks(self) -> PlanProject:
        _reject_duplicates(self.tasks, "task")
        return self


def _reject_duplicates(items: list[object], kind: str) -> None:
    ids = [getattr(item, f"{kind}_id") for item in items]
    names = [item.name for item in items]
    if len(ids) != len(set(ids)):
        raise ValueError(f"duplicate {kind} ID")
    if len(names) != len(set(names)):
        raise ValueError(f"duplicate {kind} name")


class PlanCatalogPut(BaseModel):
    """PUT body: the full replacement catalog.

    ``failure_reasons=None`` (field absent) leaves the stored vocabulary
    untouched, so a client that predates the field cannot wipe it. An explicit
    list — including ``[]`` — replaces it.
    """

    base_revision: int = Field(ge=0)
    projects: list[PlanProject]
    failure_reasons: list[str] | None = None
    # Operator roster (attribution, NOT auth): the names Collect's OP picker
    # offers. Same omitted-means-keep semantics as failure_reasons.
    operators: list[str] | None = None

    @field_validator("failure_reasons", "operators")
    @classmethod
    def _normalize_vocabulary(cls, values: list[str] | None) -> list[str] | None:
        if values is None:
            return None
        normalized = [_label(value) for value in values]
        if len(normalized) != len(set(normalized)):
            raise ValueError("duplicate catalog vocabulary label")
        return normalized

    @model_validator(mode="after")
    def _unique_projects(self) -> PlanCatalogPut:
        _reject_duplicates(self.projects, "project")
        task_ids = [task.task_id for project in self.projects for task in project.tasks]
        condition_ids = [
            condition.condition_id
            for project in self.projects
            for task in project.tasks
            for condition in task.conditions
        ]
        if len(task_ids) != len(set(task_ids)):
            raise ValueError("task IDs must be unique across the catalog")
        if len(condition_ids) != len(set(condition_ids)):
            raise ValueError("condition IDs must be unique across the catalog")
        return self


def _store(request: Request) -> CaptureStore:
    return request.app.state.capture_store


@router.get("")
async def get_plans(request: Request) -> dict:
    """The shared catalog.

    ``projects: null`` (with ``updated_at: null``) means it was NEVER set —
    the client seeds it from its local copy. An explicitly emptied catalog is
    ``projects: []`` with a real timestamp, and is honored as-is.
    """
    stored = _store(request).get_plan_catalog()
    if stored is None:
        return {
            "projects": None,
            "failure_reasons": None,
            "operators": None,
            "updated_at": None,
            "revision": 0,
        }
    projects, failure_reasons, operators, updated_at, revision = stored
    return {
        "projects": projects,
        "failure_reasons": failure_reasons,
        "operators": operators,
        "updated_at": updated_at,
        "revision": revision,
    }


@router.put("")
async def put_plans(request: Request, body: PlanCatalogPut) -> dict:
    """Replace the shared catalog (validated shape, stamped server-side)."""
    store = _store(request)
    now = utc_now_iso8601()
    projects = [p.model_dump() for p in body.projects]
    try:
        stored = store.replace_plan_catalog(
            projects,
            base_revision=body.base_revision,
            updated_at=now,
            failure_reasons=(
                body.failure_reasons
                if "failure_reasons" in body.model_fields_set
                else None
            ),
            operators=body.operators if "operators" in body.model_fields_set else None,
            keep_failure_reasons="failure_reasons" not in body.model_fields_set,
            keep_operators="operators" not in body.model_fields_set,
        )
    except PlanCatalogConflictError as exc:
        raise ApiError(
            status_code=409,
            code="plans_conflict",
            message=(
                "This catalog was edited elsewhere. Reload it and apply your "
                "changes again."
            ),
            details={
                "current_revision": exc.current_revision,
                "base_revision": body.base_revision,
            },
        ) from exc
    _, effective_reasons, effective_operators, _, revision = stored
    return {
        "projects": projects,
        "failure_reasons": effective_reasons,
        "operators": effective_operators,
        "updated_at": now,
        "revision": revision,
    }
