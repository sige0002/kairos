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
from typing import Any, Literal

from fastapi import APIRouter, Request
from kairos_common import ApiError, utc_now_iso8601
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

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


class FailureShortcuts(BaseModel):
    """Per-task fast paths for the three logical external operator actions.

    ``left`` / ``center`` / ``right`` are vendor-neutral names for the logical
    actions a foot pedal (or a keyboard) can trigger during collection; each
    slot references one label from the shared ``failure_reasons`` vocabulary,
    or ``None`` when unassigned. The full vocabulary stays available in the
    Collect UI — these three slots are shortcuts, not a replacement for it.
    """

    left: str | None = None
    center: str | None = None
    right: str | None = None


class _ExternalControlStateMap(BaseModel):
    """Three logical channels with no duplicate non-None action."""

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def _unique_actions(self) -> _ExternalControlStateMap:
        assigned = [
            action
            for action in (self.left, self.center, self.right)
            if action != "none"
        ]
        if len(assigned) != len(set(assigned)):
            raise ValueError(
                "an external-control action cannot be assigned to two channels"
            )
        return self


class ExternalControlReady(_ExternalControlStateMap):
    left: Literal["none", "start"]
    center: Literal["none", "start"]
    right: Literal["none", "start"]


class ExternalControlRecording(_ExternalControlStateMap):
    left: Literal["none", "stop"]
    center: Literal["none", "stop"]
    right: Literal["none", "stop"]


class ExternalControlResult(_ExternalControlStateMap):
    left: Literal["none", "success_save", "failure", "retake"]
    center: Literal["none", "success_save", "failure", "retake"]
    right: Literal["none", "success_save", "failure", "retake"]


class ExternalControlFailureReason(_ExternalControlStateMap):
    left: Literal["none", "reason_slot_1", "reason_slot_2", "reason_slot_3"]
    center: Literal["none", "reason_slot_1", "reason_slot_2", "reason_slot_3"]
    right: Literal["none", "reason_slot_1", "reason_slot_2", "reason_slot_3"]


class ExternalControlsConfig(BaseModel):
    """Installation-wide state-safe mapping for logical external channels."""

    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1]
    ready: ExternalControlReady
    recording: ExternalControlRecording
    result: ExternalControlResult
    failure_reason: ExternalControlFailureReason


class PlanTask(BaseModel):
    """One task and the fixed conditions it may be recorded under."""

    task_id: str = Field(
        min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$"
    )
    name: str = Field(max_length=200)
    conditions: list[PlanCondition] = Field(default_factory=list)
    failure_shortcuts: FailureShortcuts = Field(default_factory=FailureShortcuts)

    _normalize_id = field_validator("task_id")(_entity_id)
    _normalize_name = field_validator("name")(_label)

    @model_validator(mode="after")
    def _unique_conditions(self) -> PlanTask:
        _reject_duplicates(self.conditions, "condition")
        return self

    @model_validator(mode="after")
    def _unique_failure_shortcuts(self) -> PlanTask:
        assigned = [
            reason
            for reason in (
                self.failure_shortcuts.left,
                self.failure_shortcuts.center,
                self.failure_shortcuts.right,
            )
            if reason is not None
        ]
        if len(assigned) != len(set(assigned)):
            raise ValueError(
                "failure shortcuts must not assign the same reason to two slots"
            )
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
    # Installation-global logical channel mapping. Omitted means keep the
    # stored value so older clients cannot erase a layout they do not know.
    external_controls: ExternalControlsConfig | None = None

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
            "external_controls": None,
            "updated_at": None,
            "revision": 0,
        }
    (
        projects,
        failure_reasons,
        operators,
        external_controls,
        updated_at,
        revision,
    ) = stored
    return {
        "projects": projects,
        "failure_reasons": failure_reasons,
        "operators": operators,
        "external_controls": external_controls,
        "updated_at": updated_at,
        "revision": revision,
    }


def _validate_failure_shortcuts(
    projects: list[PlanProject], vocabulary: list[str]
) -> None:
    """Every assigned shortcut must name a reason in the EFFECTIVE vocabulary.

    The effective one is the list this PUT submits when it carries one, else
    the stored list (omitted means "keep"). Checked here — not in the model —
    because it is the only place that knows both halves.
    """
    allowed = set(vocabulary)
    for project in projects:
        for task in project.tasks:
            for slot, reason in (
                ("left", task.failure_shortcuts.left),
                ("center", task.failure_shortcuts.center),
                ("right", task.failure_shortcuts.right),
            ):
                if reason is not None and reason not in allowed:
                    raise ApiError(
                        status_code=422,
                        code="failure_shortcut_unknown_reason",
                        message=(
                            f"Task {task.task_id!r} assigns {slot} shortcut to "
                            f"“{reason}”, which is not in the shared failure "
                            "reason vocabulary."
                        ),
                        details={
                            "task_id": task.task_id,
                            "slot": slot,
                            "reason": reason,
                        },
                    )


def _merge_failure_shortcuts(
    projects: list[PlanProject],
    stored: tuple[
        list[Any],
        list[str] | None,
        list[str] | None,
        dict[str, Any] | None,
        str,
        int,
    ]
    | None,
) -> list[PlanProject]:
    """Restore stored shortcut slots for tasks a legacy PUT omits the field on.

    A client that predates ``failure_shortcuts`` sends tasks without the key;
    Pydantic would default it to empty slots and silently wipe every configured
    mapping. When the field was absent in the payload, the mapping stored under
    the same ``task_id`` wins; an explicit object (including all-null) stays
    authoritative; a task new to the catalog starts with unassigned slots.
    """
    if stored is None:
        return projects
    stored_by_task: dict[str, dict[str, str | None]] = {}
    for project in stored[0]:
        for task in project.get("tasks", []):
            task_id = task.get("task_id")
            shortcuts = task.get("failure_shortcuts")
            if not isinstance(task_id, str) or not task_id:
                continue
            if not isinstance(shortcuts, dict):
                continue
            stored_by_task[task_id] = {
                slot: shortcuts.get(slot) for slot in ("left", "center", "right")
            }
    merged: list[PlanProject] = []
    for project in projects:
        tasks = list(project.tasks)
        changed = False
        for index, task in enumerate(tasks):
            if "failure_shortcuts" in task.model_fields_set:
                continue
            shortcuts = stored_by_task.get(task.task_id)
            if shortcuts is None:
                continue
            tasks[index] = task.model_copy(
                update={"failure_shortcuts": FailureShortcuts(**shortcuts)}
            )
            changed = True
        merged.append(
            project.model_copy(update={"tasks": tasks}) if changed else project
        )
    return merged


@router.put("")
async def put_plans(request: Request, body: PlanCatalogPut) -> dict:
    """Replace the shared catalog (validated shape, stamped server-side)."""
    store = _store(request)
    stored = store.get_plan_catalog()
    if "failure_reasons" in body.model_fields_set:
        effective_vocabulary = body.failure_reasons or []
    else:
        effective_vocabulary = (stored[1] if stored is not None else None) or []
    # A legacy PUT omits failure_shortcuts per task; merge the stored mapping
    # back BEFORE validation so the vocabulary check sees the effective
    # catalog that will actually be persisted (not Pydantic's empty defaults).
    projects = _merge_failure_shortcuts(body.projects, stored)
    _validate_failure_shortcuts(projects, effective_vocabulary)
    now = utc_now_iso8601()
    projects_payload = [p.model_dump() for p in projects]
    try:
        stored = store.replace_plan_catalog(
            projects_payload,
            base_revision=body.base_revision,
            updated_at=now,
            failure_reasons=(
                body.failure_reasons
                if "failure_reasons" in body.model_fields_set
                else None
            ),
            operators=body.operators if "operators" in body.model_fields_set else None,
            external_controls=(
                body.external_controls.model_dump()
                if body.external_controls is not None
                else None
            ),
            keep_failure_reasons="failure_reasons" not in body.model_fields_set,
            keep_operators="operators" not in body.model_fields_set,
            keep_external_controls="external_controls" not in body.model_fields_set,
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
    (
        _,
        effective_reasons,
        effective_operators,
        effective_external_controls,
        _,
        revision,
    ) = stored
    return {
        "projects": projects_payload,
        "failure_reasons": effective_reasons,
        "operators": effective_operators,
        "external_controls": effective_external_controls,
        "updated_at": now,
        "revision": revision,
    }
