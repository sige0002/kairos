"""Validation template endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Query, Request, status
from kairos_common import ApiError

from api_orchestrator.models import (
    TemplateGenerateRequest,
    ValidationTemplate,
    ValidationTemplateListResponse,
)

router = APIRouter(prefix="/api/v1/validation/templates", tags=["validation"])


@router.get("", response_model=ValidationTemplateListResponse)
async def list_templates(
    request: Request,
    limit: int = Query(default=50, ge=1, le=200),
    cursor: str | None = None,
) -> ValidationTemplateListResponse:
    """List validation templates from the local store."""
    try:
        parsed = int(cursor) if cursor is not None else None
    except ValueError as exc:
        raise ApiError(
            status_code=400,
            code="invalid_cursor",
            message="cursor must be an opaque token from a prior page.",
        ) from exc
    items, next_cursor = request.app.state.run_store.list_templates(limit, parsed)
    return ValidationTemplateListResponse(
        items=items, next_cursor=str(next_cursor) if next_cursor is not None else None
    )


@router.post("", response_model=ValidationTemplate, status_code=status.HTTP_201_CREATED)
async def create_template(
    request: Request, body: ValidationTemplate
) -> ValidationTemplate:
    """Persist a validation template locally and forward it to dora_runner."""
    request.app.state.run_store.create_template(body)
    await request.app.state.dora_runner_client.create_template(body.model_dump())
    return body


@router.post("/generate", response_model=ValidationTemplate)
async def generate_template(
    request: Request, body: TemplateGenerateRequest
) -> ValidationTemplate:
    """Generate a draft template from an existing run via dora_runner."""
    generated = await request.app.state.dora_runner_client.generate_template(
        body.model_dump()
    )
    return ValidationTemplate.model_validate(generated)
