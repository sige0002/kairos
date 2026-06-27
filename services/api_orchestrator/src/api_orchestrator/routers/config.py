"""Config endpoints (``/api/v1/config/options`` + ``/select`` + ``/recording``).

The Config tab reads the per-category options and the active selection, and
posts a selection. Phase 1 = the ``validation`` category (applies immediately;
the active template is injected into template-less fast_validation jobs).

``/recording`` exposes the full RECORDING_CONFIG for in-UI editing (task T-C1):
``GET`` returns the live config; ``PUT`` validates + atomically persists it to
the on-prem ``settings.recording_config`` file and updates the in-memory copy so
``GET /api/v1/config`` and the next start reflect it immediately. Recorder QoS
and monitor expected_hz/allowlist still load at service startup, so those parts
only fully apply on restart (the UI says so honestly).
"""

from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path
from typing import Any

import yaml
from fastapi import APIRouter, Request
from kairos_common import ApiError, load_recording_config, load_stream_config
from kairos_common.recording_config import RecordingConfig
from pydantic import BaseModel, ValidationError

from api_orchestrator.config_catalog import ASPECTS, ConfigCatalog

logger = logging.getLogger("kairos")

router = APIRouter(prefix="/api/v1/config", tags=["config"])


class ConfigSelectRequest(BaseModel):
    """Body for ``POST /api/v1/config/select``."""

    category: str
    id: str


class RecordingConfigBody(BaseModel):
    """Body for ``PUT /api/v1/config/recording``: ``{config: <object>}``.

    ``config`` is an opaque mapping here; it is validated against
    :class:`RecordingConfig` in the handler so a schema error surfaces as a 422
    with the offending fields (rather than a generic body-shape rejection).
    """

    config: dict[str, Any]


def _catalog(request: Request) -> ConfigCatalog:
    return request.app.state.config_catalog


def _options_payload(catalog: ConfigCatalog) -> dict[str, Any]:
    """Robot-first options: the active robot, all robots, and per-aspect options."""
    return {
        "active_robot": catalog.active_robot(),
        "robots": [r.model_dump() for r in catalog.list_robots()],
        "aspects": {
            aspect: {
                "active": catalog.active_option(aspect),
                "options": [o.model_dump() for o in catalog.list_aspect(aspect)],
            }
            for aspect in ASPECTS
        },
    }


def _apply_recording(request: Request, catalog: ConfigCatalog) -> None:
    """Hot-swap the live RECORDING_CONFIG to the active robot's active option."""
    path = catalog.resolve_path("recording")
    if path is None:
        return
    try:
        config = load_recording_config(path)
    except (ValueError, OSError) as exc:
        raise ApiError(
            status_code=422,
            code="invalid_config",
            message=f"Recording config failed to load: {path}",
            details={"error": str(exc)},
        ) from exc
    request.app.state.recording_config = config
    request.app.state.recording_config_path = str(path)
    request.app.state.run_service.set_recording_config(config)
    logger.info("recording config applied", extra={"path": str(path)})


def _apply_stream(request: Request, catalog: ConfigCatalog) -> None:
    """Hot-swap the live STREAM_CONFIG (read by GET /api/v1/config) to the active
    robot's active option; ``None`` when the robot has no stream option."""
    path = catalog.resolve_path("stream")
    if path is None:
        request.app.state.stream_config = None
        request.app.state.stream_config_path = None
        return
    try:
        config = load_stream_config(path)
    except (ValueError, OSError) as exc:
        raise ApiError(
            status_code=422,
            code="invalid_config",
            message=f"Stream config failed to load: {path}",
            details={"error": str(exc)},
        ) from exc
    request.app.state.stream_config = config
    request.app.state.stream_config_path = str(path)
    logger.info("stream config applied", extra={"path": str(path)})


@router.get("/options")
async def config_options(request: Request) -> dict[str, Any]:
    """List selectable config options + the active selection, robot-first."""
    return _options_payload(_catalog(request))


@router.post("/select")
async def config_select(request: Request, body: ConfigSelectRequest) -> dict[str, Any]:
    """Switch the active robot or an aspect option, hot-swapping the live copies.

    Recording / stream selections (and a robot switch, which re-points both) take
    effect for ``GET /api/v1/config`` immediately; recorder QoS / monitor
    expected_hz still load at startup, so those parts apply on restart.
    """
    catalog = _catalog(request)
    catalog.select(body.category, body.id)
    if body.category in ("robot", "recording"):
        _apply_recording(request, catalog)
    if body.category in ("robot", "stream"):
        _apply_stream(request, catalog)
    return _options_payload(catalog)


# ---- recording config (full editor) --------------------------------------


def _recording_payload(config: RecordingConfig | None, path: str) -> dict[str, Any]:
    """Shape the GET/PUT response: the config dump (or null) + its file path."""
    return {
        "config": config.model_dump(mode="json") if config is not None else None,
        "path": path,
    }


def _atomic_write_yaml(path: Path, data: dict[str, Any]) -> None:
    """Write *data* to *path* as YAML atomically (temp file + ``os.replace``).

    Creates the parent dir if needed. The temp file is created in the same
    directory so ``os.replace`` is an atomic same-filesystem rename; on any
    failure the temp file is removed and the original is left untouched.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp"
    )
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            yaml.safe_dump(data, fh, sort_keys=False, allow_unicode=True)
        os.replace(tmp, path)
    except OSError:
        tmp.unlink(missing_ok=True)
        raise


@router.get("/recording")
async def get_recording_config(request: Request) -> dict[str, Any]:
    """Return the live RECORDING_CONFIG (or ``config: null``) + its file path.

    Sourced from ``app.state.recording_config`` (live), so it reflects any prior
    PUT without a restart.
    """
    settings = request.app.state.settings
    config: RecordingConfig | None = request.app.state.recording_config
    path = getattr(
        request.app.state, "recording_config_path", settings.recording_config
    )
    return _recording_payload(config, path)


@router.put("/recording")
async def put_recording_config(
    request: Request, body: RecordingConfigBody
) -> dict[str, Any]:
    """Validate, atomically persist, and hot-swap the RECORDING_CONFIG.

    The full :class:`RecordingConfig` is editable. On success the validated
    config is written to ``settings.recording_config`` (the only path we ever
    write — never one from the request) and set on ``app.state.recording_config``
    + the RunService, so ``GET /api/v1/config`` and the next start's
    ``default_topics`` reflect it immediately. A schema error yields 422 with the
    field errors; the file is left untouched on any validation failure.
    """
    try:
        config = RecordingConfig.model_validate(body.config)
    except ValidationError as exc:
        raise ApiError(
            status_code=422,
            code="invalid_config",
            message="Recording config failed validation.",
            details={"errors": exc.errors(include_url=False)},
        ) from exc

    settings = request.app.state.settings
    # Write to the ACTIVE recording file (a robot selection may have re-pointed it
    # to a gitignored config/local/<robot>/... path) — never one from the request.
    path = Path(
        getattr(request.app.state, "recording_config_path", settings.recording_config)
    )
    try:
        _atomic_write_yaml(path, config.model_dump(mode="json"))
    except OSError as exc:
        logger.warning("recording config write failed", extra={"error": str(exc)})
        raise ApiError(
            status_code=500,
            code="config_write_failed",
            message="Could not persist the recording config.",
            details={"path": str(path)},
        ) from exc

    # Hot-swap the live copies so the next GET /api/v1/config and the next
    # start's topic resolution use the new config without a restart.
    request.app.state.recording_config = config
    request.app.state.run_service.set_recording_config(config)
    logger.info("recording config updated", extra={"path": str(path)})
    return _recording_payload(config, settings.recording_config)
