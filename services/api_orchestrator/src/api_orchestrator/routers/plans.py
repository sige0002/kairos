"""Shared plan catalog (Projects -> Tasks -> Conditions) — ``/api/v1/plans``.

The catalog is the label VOCABULARY Collect stamps onto batches and episodes
(``project`` / ``task`` / ``condition``), plus the ``failure_reasons`` list
Collect offers when an episode is marked Failure. Serving it from the
orchestrator puts every terminal on ONE vocabulary — with the previous
browser-local copies, two laptops could label the same physical condition with
different strings, quietly fragmenting the exported labels (fixed vocabulary
is what makes labels aggregable).

This is deliberately NOT the Phase 2.5 Plan model: no plan ids, no batch
references, no per-plan targets. Batches keep storing plain strings; this is
just the persisted catalog the pickers offer. Last writer wins (single-team
LAN scope, no auth — same trust model as the rest of the API).
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from kairos_common import utc_now_iso8601
from pydantic import BaseModel, Field

from api_orchestrator.store import CaptureStore

router = APIRouter(prefix="/api/v1/plans", tags=["plans"])


class PlanTask(BaseModel):
    """One task and the fixed conditions it may be recorded under."""

    name: str
    conditions: list[str] = Field(default_factory=list)


class PlanProject(BaseModel):
    """One project grouping its tasks."""

    name: str
    tasks: list[PlanTask] = Field(default_factory=list)


class PlanCatalogPut(BaseModel):
    """PUT body: the full replacement catalog.

    ``failure_reasons=None`` (field absent) leaves the stored vocabulary
    untouched, so a client that predates the field cannot wipe it. An explicit
    list — including ``[]`` — replaces it.
    """

    projects: list[PlanProject]
    failure_reasons: list[str] | None = None
    # Operator roster (attribution, NOT auth): the names Collect's OP picker
    # offers. Same omitted-means-keep semantics as failure_reasons.
    operators: list[str] | None = None


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
        }
    projects, failure_reasons, operators, updated_at = stored
    return {
        "projects": projects,
        "failure_reasons": failure_reasons,
        "operators": operators,
        "updated_at": updated_at,
    }


@router.put("")
async def put_plans(request: Request, body: PlanCatalogPut) -> dict:
    """Replace the shared catalog (validated shape, stamped server-side)."""
    store = _store(request)
    now = utc_now_iso8601()
    projects = [p.model_dump() for p in body.projects]
    store.set_plan_catalog(projects, now, body.failure_reasons, body.operators)
    stored = store.get_plan_catalog()
    effective_reasons = stored[1] if stored is not None else body.failure_reasons
    effective_operators = stored[2] if stored is not None else body.operators
    return {
        "projects": projects,
        "failure_reasons": effective_reasons,
        "operators": effective_operators,
        "updated_at": now,
    }
