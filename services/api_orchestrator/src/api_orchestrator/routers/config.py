"""Config catalog endpoints (``/api/v1/config/options`` + ``/select``).

The Config tab reads the per-category options and the active selection, and
posts a selection. Phase 1 = the ``validation`` category (applies immediately;
the active template is injected into template-less fast_validation jobs).
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel

from api_orchestrator.config_catalog import ConfigCatalog

router = APIRouter(prefix="/api/v1/config", tags=["config"])


class ConfigSelectRequest(BaseModel):
    """Body for ``POST /api/v1/config/select``."""

    category: str
    id: str


def _catalog(request: Request) -> ConfigCatalog:
    return request.app.state.config_catalog


def _options_payload(catalog: ConfigCatalog) -> dict[str, Any]:
    return {
        "validation": {
            "active": catalog.active_id("validation"),
            "options": [o.model_dump() for o in catalog.list_validation()],
        }
    }


@router.get("/options")
async def config_options(request: Request) -> dict[str, Any]:
    """List selectable config options + the active selection, per category."""
    return _options_payload(_catalog(request))


@router.post("/select")
async def config_select(request: Request, body: ConfigSelectRequest) -> dict[str, Any]:
    """Set the active option for a category (immediate-apply categories only)."""
    catalog = _catalog(request)
    catalog.select(body.category, body.id)
    return _options_payload(catalog)
