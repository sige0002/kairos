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

    Presets come from the active robot's ``validation_presets.yaml``. For each
    one, the target set (terminal captures whose bytes are on this host) and the
    subset still missing that pipeline's report are computed live, so the UI can
    show "N pending" and run exactly those. Nothing here mutates state.
    """
    catalog = request.app.state.config_catalog
    service = request.app.state.capture_service
    targets = service.present_terminal_ids()
    items = []
    for preset in catalog.list_validation_presets():
        # One listing of the pipeline's report directory, then a set
        # difference — rather than asking the filesystem about every target.
        # This endpoint is polled, and the per-capture form made its cost grow
        # with the whole catalog (E-27).
        reported = service.captures_with_report(preset.pipeline)
        pending = [capture_id for capture_id in targets if capture_id not in reported]
        items.append(
            ValidationPresetInfo(
                id=preset.id,
                name=preset.name,
                description=preset.description,
                pipeline=preset.pipeline,
                params=preset.params,
                total=len(targets),
                pending=len(pending),
                pending_capture_ids=pending,
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
    items, next_cursor = request.app.state.capture_store.list_templates(limit, parsed)
    return ValidationTemplateListResponse(
        items=items, next_cursor=str(next_cursor) if next_cursor is not None else None
    )


@router.post("", response_model=ValidationTemplate, status_code=status.HTTP_201_CREATED)
async def create_template(
    request: Request, body: ValidationTemplate
) -> ValidationTemplate:
    """Persist a validation template locally and forward it to dora_runner."""
    request.app.state.capture_store.create_template(body)
    await request.app.state.dora_runner_client.create_template(body.model_dump())
    return body


@router.post("/generate", response_model=ValidationTemplate)
async def generate_template(
    request: Request, body: TemplateGenerateRequest
) -> ValidationTemplate:
    """Generate a draft template from an existing capture via dora_runner."""
    generated = await request.app.state.dora_runner_client.generate_template(
        body.model_dump()
    )
    return ValidationTemplate.model_validate(generated)
