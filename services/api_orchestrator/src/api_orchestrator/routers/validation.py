"""Validation template + one-click preset endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Query, Request, status
from kairos_common import ApiError

from api_orchestrator.models import (
    TemplateGenerateRequest,
    ValidationPresetInfo,
    ValidationPresetListResponse,
    ValidationTemplate,
    ValidationTemplateListResponse,
)

router = APIRouter(prefix="/api/v1/validation/templates", tags=["validation"])

# Presets live one level up (/api/v1/validation/presets), so they get their own
# router; both are registered by app_factory.
presets_router = APIRouter(prefix="/api/v1/validation", tags=["validation"])


@presets_router.get("/presets", response_model=ValidationPresetListResponse)
async def list_presets(request: Request) -> ValidationPresetListResponse:
    """List one-click validation presets with their not-yet-validated targets.

    Presets come from the active robot's ``validation_presets.yaml``; for each,
    the completed-recording target set and the subset still missing that
    pipeline's report are computed live (so the UI can show "N pending" and run
    exactly those). Nothing here mutates state.
    """
    catalog = request.app.state.config_catalog
    service = request.app.state.run_service
    total = len(service.list_completed_with_files())
    items = []
    for preset in catalog.list_validation_presets():
        pending_run_ids = service.pending_run_ids(preset.pipeline)
        items.append(
            ValidationPresetInfo(
                id=preset.id,
                name=preset.name,
                description=preset.description,
                pipeline=preset.pipeline,
                params=preset.params,
                total=total,
                pending=len(pending_run_ids),
                pending_run_ids=pending_run_ids,
            )
        )
    return ValidationPresetListResponse(items=items)


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
