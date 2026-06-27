"""Config-driven defaults for the ``loss_report`` validator (OL-4.3).

The ``loss_report`` thresholds and target-topic globs used to be hardcoded code
constants. They now live in a YAML file (``config/<robot>/validators/loss_report.yaml``,
mounted at ``/config/<robot>/validators/loss_report.yaml`` in Docker) so an operator can
tune them without a code change. The values flow three ways:

1. these YAML values seed the job ``params`` defaults at execution time, and
2. they are surfaced as the ``default`` of each property in the pipeline's
   ``params_schema`` (so the auto-rendered form starts pre-filled), and
3. an individual job's ``params`` still override them per-run.

When the file is absent or a key is missing we fall back to the code defaults
below, so existing behaviour (and the unit tests) is unchanged when no config
is present — the loader never raises on a missing file.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from pathlib import Path

import yaml

logger = logging.getLogger("kairos")

# Env var pointing at the loss_report validator config; defaults to the Docker
# mount path. Missing file -> code defaults (below).
LOSS_REPORT_CONFIG_ENV = "LOSS_REPORT_CONFIG"


def _default_loss_report_path() -> str:
    """Host/dev fallback when ``LOSS_REPORT_CONFIG`` is unset: the active ROBOT's
    committed validators file. Deployments set ``LOSS_REPORT_CONFIG`` explicitly
    (Makefile / compose derive it from ``ROBOT``, resolving gitignored
    ``config/local/<robot>/`` too), and that always wins over this default.
    """
    robot = os.environ.get("ROBOT", "airoa_hsr")
    return f"/config/{robot}/validators/loss_report.yaml"


DEFAULT_LOSS_REPORT_CONFIG_PATH = _default_loss_report_path()

# Code defaults (used when the file or a key is absent). A multiplier of 5.0
# flags a topic whose worst gap is 5x its own median cadence; an empty target
# list means "report every topic" (the original behaviour).
DEFAULT_GAP_THRESHOLD_MULTIPLIER = 5.0


@dataclass(frozen=True)
class LossReportConfig:
    """Effective loss_report defaults (from YAML, falling back to code)."""

    gap_threshold_multiplier: float = DEFAULT_GAP_THRESHOLD_MULTIPLIER
    target_topics: list[str] = field(default_factory=list)


def coerce_multiplier(value: object) -> float:
    """Best-effort coerce a config/param value to a positive float multiplier."""
    try:
        out = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return DEFAULT_GAP_THRESHOLD_MULTIPLIER
    return out if out > 0 else DEFAULT_GAP_THRESHOLD_MULTIPLIER


def coerce_target_topics(value: object) -> list[str]:
    """Coerce a config/param value into a clean list of glob strings."""
    if value is None:
        return []
    if isinstance(value, str):
        # Allow a single glob or a comma/space separated string for convenience.
        parts = [p.strip() for p in value.replace(",", " ").split()]
        return [p for p in parts if p]
    if isinstance(value, (list, tuple)):
        return [str(p).strip() for p in value if str(p).strip()]
    return []


def load_loss_report_config(path: str | Path | None = None) -> LossReportConfig:
    """Load loss_report defaults from YAML; fall back to code defaults.

    *path* defaults to ``$LOSS_REPORT_CONFIG`` then
    ``/config/<robot>/validators/loss_report.yaml``. A missing file is normal (dev/host
    runs) and yields the code defaults; a malformed file is logged and also
    falls back rather than failing service startup.
    """
    resolved = Path(
        path
        if path is not None
        else os.environ.get(LOSS_REPORT_CONFIG_ENV, DEFAULT_LOSS_REPORT_CONFIG_PATH)
    )
    if not resolved.is_file():
        return LossReportConfig()
    try:
        raw = yaml.safe_load(resolved.read_text(encoding="utf-8")) or {}
    except (OSError, yaml.YAMLError) as exc:
        logger.warning(
            "loss_report config invalid; using defaults",
            extra={"path": str(resolved), "error": str(exc)},
        )
        return LossReportConfig()
    if not isinstance(raw, dict):
        return LossReportConfig()
    return LossReportConfig(
        gap_threshold_multiplier=coerce_multiplier(
            raw.get("gap_threshold_multiplier", DEFAULT_GAP_THRESHOLD_MULTIPLIER)
        ),
        target_topics=coerce_target_topics(raw.get("target_topics")),
    )
