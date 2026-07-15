"""Config endpoints (``/api/v1/config/options`` + ``/select`` + ``/recording``
+ ``/signals`` + ``/alerts``).

The Config tab reads the per-category options and the active selection, and
posts a selection. Phase 1 = the ``validation`` category (applies immediately;
the active template is injected into template-less fast_validation jobs).

``/recording`` exposes the full RECORDING_CONFIG for in-UI editing (task T-C1):
``GET`` returns the live config; ``PUT`` validates + atomically persists it to
the on-prem ``settings.recording_config`` file and updates the in-memory copy so
``GET /api/v1/config`` and the next start reflect it immediately. Recorder QoS
and monitor expected_hz/allowlist still load at service startup, so those parts
only fully apply on restart (the UI says so honestly).

``/signals`` and ``/alerts`` are the two per-robot single-file aspect editors
Settings > Data quality drives (S1' / F2''). Both resolve the ACTIVE robot's
file through the catalog (``config/<robot>/signals/default.yaml`` and
``config/<robot>/monitoring/alerts.yaml``), ``GET`` returns the parsed config +
raw YAML text + path, and ``PUT`` validates (pydantic, unknown keys rejected)
then atomically rewrites the file with the same temp-file + ``os.replace`` path
as ``/recording``. Signals is display-only (applies immediately — the Review
consumption hook re-fetches it); alerts load once at topic_monitor startup, so
an alerts edit applies on the next monitor restart (no live-reload path exists —
see ``topic_monitor/main.py``).
"""

from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path
from typing import Annotated, Any, Literal

import yaml
from fastapi import APIRouter, Request
from kairos_common import ApiError, load_recording_config, load_stream_config
from kairos_common.recording_config import RecordingConfig
from pydantic import BaseModel, ConfigDict, Field, ValidationError

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


@router.get("/robots/{robot}")
async def get_robot_config(request: Request, robot: str) -> dict[str, Any]:
    """Read-only config for a named robot (active or not), for the Settings UI.

    Returns each aspect's selected/default file content (or null) plus a derived
    summary. The robot name is a single path segment (FastAPI) and must be a
    known robot from the catalog, else 404 — nothing here mutates the active
    selection, so a non-active robot can be inspected as a template.
    """
    described = _catalog(request).describe_robot(robot)
    if described is None:
        raise ApiError(
            status_code=404,
            code="config_not_found",
            message=f"Robot not found: {robot}",
            details={"robot": robot},
        )
    return described


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


# ---- signals + alerts config (per-robot single-file aspect editors) --------
# S1' / F2'': the two config aspects Settings > Data quality reads and writes.
# Neither is a selectable Config-tab option (each is a single fixed file per
# robot), so they get dedicated GET/PUT endpoints rather than a catalog aspect,
# resolving the ACTIVE robot's file through ConfigCatalog.robot_config_file.

SIGNALS_SUBDIR, SIGNALS_FILENAME = "signals", "default.yaml"
ALERTS_SUBDIR, ALERTS_FILENAME = "monitoring", "alerts.yaml"


class SignalDefaultRule(BaseModel):
    """One per-msg_type default field selection for the Review Signals view."""

    model_config = ConfigDict(extra="forbid")

    msg_type: str
    fields: list[str] = Field(default_factory=list)


class SignalsConfig(BaseModel):
    """Signals default display config (``config/<robot>/signals/default.yaml``).

    Display-only: the Review consumption hook (``signalDefaults.ts``) fetches it
    and picks the default topic + fields per report. Unknown keys are rejected so
    a typo surfaces as a 422 instead of being silently dropped at render time.
    """

    model_config = ConfigDict(extra="forbid")

    hidden_field_patterns: list[str] = Field(default_factory=list)
    default_topic: str | None = None
    defaults: list[SignalDefaultRule] = Field(default_factory=list)
    fallback_fields: Annotated[int, Field(ge=0)] = 4


# Built-in fallback returned by GET when a robot has no signals file yet — the
# same defaults signalDefaults.ts falls back to (hide header.*, first 4 leaves).
DEFAULT_SIGNALS = SignalsConfig(hidden_field_patterns=["header.*"])

# Alert vocabulary MIRRORS topic_monitor's AlertRule / DerivedRulesConfig (a
# 1-folder-1-container service the orchestrator can't import from). Metric/op are
# the exact sets the monitor accepts so a valid alerts.yaml round-trips through
# the editor; `loss` stays a VALID metric (a real alerts.yaml may carry one) but
# the PUT response warns that it can never fire (loss_rate is null in ROS 2).
AlertMetric = Literal["hz", "bandwidth", "gap", "late", "loss"]
AlertOp = Literal["lt", "gt", "le", "ge"]


class AlertRuleModel(BaseModel):
    """One threshold alert rule (mirrors topic_monitor.models.AlertRule)."""

    model_config = ConfigDict(extra="forbid")

    topic: str
    metric: AlertMetric
    op: AlertOp
    threshold: float
    clear_after_s: Annotated[float, Field(ge=0)] = 0.0
    cooldown_s: Annotated[float, Field(ge=0)] = 0.0
    severity: str = "warning"


class DerivedRulesModel(BaseModel):
    """Auto-derived hz-rule tuning (mirrors topic_monitor.DerivedRulesConfig)."""

    model_config = ConfigDict(extra="forbid")

    enabled: bool = True
    warn_ratio: Annotated[float, Field(gt=0, le=1)] = 0.8
    danger_ratio: Annotated[float, Field(gt=0, le=1)] = 0.5
    sustain_s: Annotated[float, Field(ge=0)] = 10.0
    clear_after_s: Annotated[float, Field(ge=0)] = 3.0
    cooldown_s: Annotated[float, Field(ge=0)] = 10.0


class AlertsConfig(BaseModel):
    """Alerts config (``config/<robot>/monitoring/alerts.yaml``)."""

    model_config = ConfigDict(extra="forbid")

    rules: list[AlertRuleModel] = Field(default_factory=list)
    derived_rules: DerivedRulesModel | None = None


class AspectConfigBody(BaseModel):
    """PUT body for the single-file aspect editors: ``{config}`` OR ``{raw}``.

    The Settings form sends a parsed ``config`` object; the Advanced editor sends
    ``raw`` YAML text (the frontend ships no YAML parser, so the server parses
    it). Exactly one is required; both are normalised to a mapping, validated,
    and rewritten canonically.
    """

    config: dict[str, Any] | None = None
    raw: str | None = None


def _body_to_mapping(body: AspectConfigBody) -> dict[str, Any]:
    """Normalise an :class:`AspectConfigBody` to a plain mapping (422 on error)."""
    if body.raw is not None:
        try:
            data = yaml.safe_load(body.raw)
        except yaml.YAMLError as exc:
            raise ApiError(
                status_code=422,
                code="invalid_yaml",
                message="Config is not valid YAML.",
                details={"error": str(exc)},
            ) from exc
        data = data if data is not None else {}
        if not isinstance(data, dict):
            raise ApiError(
                status_code=422,
                code="invalid_config",
                message="Config must be a YAML mapping.",
            )
        return data
    if body.config is not None:
        return body.config
    raise ApiError(
        status_code=422,
        code="invalid_config",
        message="Provide either `config` (object) or `raw` (YAML text).",
    )


def _read_yaml_text(path: Path | None) -> tuple[str | None, dict[str, Any] | None]:
    """Best-effort (raw_text, parsed_mapping) for *path*; (None, None) if absent."""
    if path is None or not path.exists():
        return None, None
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return None, None
    try:
        data = yaml.safe_load(raw)
    except yaml.YAMLError:
        return raw, None
    return raw, data if isinstance(data, dict) else {}


def _alert_loss_warnings(config: AlertsConfig) -> list[str]:
    """Warn (never reject) on `metric: loss` rules — they can never fire."""
    return [
        f"Rule for {r.topic}: metric 'loss' can never fire "
        "(loss_rate is null in the monitor); use hz or gap instead."
        for r in config.rules
        if r.metric == "loss"
    ]


@router.get("/signals")
async def get_signals_config(request: Request) -> dict[str, Any]:
    """Return the active robot's Signals default-display config + raw YAML.

    When the robot has no ``signals/default.yaml`` yet, ``config`` is the
    built-in default (so the Settings form has something to edit) and ``raw`` is
    ``null``. A present-but-invalid file returns its raw parsed mapping so the
    editor can fix it in place.
    """
    path = _catalog(request).robot_config_file(SIGNALS_SUBDIR, SIGNALS_FILENAME)
    raw, parsed = _read_yaml_text(path)
    if raw is None:
        config: dict[str, Any] | None = DEFAULT_SIGNALS.model_dump(mode="json")
    else:
        try:
            config = SignalsConfig.model_validate(parsed or {}).model_dump(mode="json")
        except ValidationError:
            config = parsed  # present-but-invalid: hand back the raw mapping
    return {"config": config, "raw": raw, "path": str(path) if path else None}


@router.put("/signals")
async def put_signals_config(
    request: Request, body: AspectConfigBody
) -> dict[str, Any]:
    """Validate + atomically persist the active robot's Signals config.

    Display-only, so there is nothing to hot-swap: the Review consumption hook
    re-fetches ``GET /config/signals`` and the change applies immediately. A
    schema error yields 422 and leaves the file untouched.
    """
    path = _catalog(request).robot_config_file(SIGNALS_SUBDIR, SIGNALS_FILENAME)
    if path is None:
        raise ApiError(
            status_code=404,
            code="config_not_found",
            message="The active robot has no config dir to write signals config.",
        )
    data = _body_to_mapping(body)
    try:
        config = SignalsConfig.model_validate(data)
    except ValidationError as exc:
        raise ApiError(
            status_code=422,
            code="invalid_config",
            message="Signals config failed validation.",
            details={"errors": exc.errors(include_url=False)},
        ) from exc
    try:
        _atomic_write_yaml(path, config.model_dump(mode="json"))
    except OSError as exc:
        logger.warning("signals config write failed", extra={"error": str(exc)})
        raise ApiError(
            status_code=500,
            code="config_write_failed",
            message="Could not persist the signals config.",
            details={"path": str(path)},
        ) from exc
    logger.info("signals config updated", extra={"path": str(path)})
    raw, _ = _read_yaml_text(path)
    return {"config": config.model_dump(mode="json"), "raw": raw, "path": str(path)}


@router.get("/alerts")
async def get_alerts_config(request: Request) -> dict[str, Any]:
    """Return the active robot's topic_monitor alert rules + raw YAML.

    ``config`` is the parsed ``{rules, derived_rules?}`` (or the raw mapping when
    present-but-invalid, or ``{rules: []}`` when the file is absent). ``warnings``
    surfaces any ``metric: loss`` rule that can never fire.
    """
    path = _catalog(request).robot_config_file(ALERTS_SUBDIR, ALERTS_FILENAME)
    raw, parsed = _read_yaml_text(path)
    warnings: list[str] = []
    if raw is None:
        config: dict[str, Any] | None = AlertsConfig().model_dump(mode="json")
    else:
        try:
            validated = AlertsConfig.model_validate(parsed or {})
            config = validated.model_dump(mode="json")
            warnings = _alert_loss_warnings(validated)
        except ValidationError:
            config = parsed  # present-but-invalid: hand back the raw mapping
    return {
        "config": config,
        "raw": raw,
        "path": str(path) if path else None,
        "warnings": warnings,
    }


@router.put("/alerts")
async def put_alerts_config(request: Request, body: AspectConfigBody) -> dict[str, Any]:
    """Validate + atomically persist the active robot's alert rules.

    topic_monitor loads alerts.yaml once at startup (no live-reload path), so the
    edit applies on the next monitor restart — the UI says so. A ``metric: loss``
    rule is accepted but reported in ``warnings`` (it can never fire).
    """
    path = _catalog(request).robot_config_file(ALERTS_SUBDIR, ALERTS_FILENAME)
    if path is None:
        raise ApiError(
            status_code=404,
            code="config_not_found",
            message="The active robot has no config dir to write alerts config.",
        )
    data = _body_to_mapping(body)
    try:
        config = AlertsConfig.model_validate(data)
    except ValidationError as exc:
        raise ApiError(
            status_code=422,
            code="invalid_config",
            message="Alerts config failed validation.",
            details={"errors": exc.errors(include_url=False)},
        ) from exc
    try:
        _atomic_write_yaml(path, config.model_dump(mode="json"))
    except OSError as exc:
        logger.warning("alerts config write failed", extra={"error": str(exc)})
        raise ApiError(
            status_code=500,
            code="config_write_failed",
            message="Could not persist the alerts config.",
            details={"path": str(path)},
        ) from exc
    logger.info("alerts config updated", extra={"path": str(path)})
    raw, _ = _read_yaml_text(path)
    return {
        "config": config.model_dump(mode="json"),
        "raw": raw,
        "path": str(path),
        "warnings": _alert_loss_warnings(config),
    }
