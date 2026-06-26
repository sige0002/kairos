"""Selectable config catalog + runtime selections for the Config tab.

Phase 1 covers the **validation** category: it lists the templates under
``config/validation/`` (one ``*.yaml`` per option, keyed by file stem) and holds
the process-local "active" selection. The active validation template is injected
into template-less ``fast_validation`` jobs (see ``routers/jobs.py``), so
switching it in the UI takes effect immediately — no restart (this is the
"validation/stream/convert apply immediately" half of the agreed design).

The selection is in-memory: it resets to the env default on restart. Persisting
it is future work (see plan_config).
"""

from __future__ import annotations

import logging
from pathlib import Path

from kairos_common import ApiError, ValidationTemplate, load_validation_template
from pydantic import BaseModel

logger = logging.getLogger("kairos")

# Categories whose selection applies immediately (no service restart).
IMMEDIATE_CATEGORIES = ("validation",)


class ValidationOption(BaseModel):
    """One selectable validation template (a Config-tab dropdown entry)."""

    id: str  # file stem (e.g. "airoa_hsr")
    name: str
    version: int
    required_topics: list[dict]


class ConfigCatalog:
    """Lists per-category config options and holds the active selection."""

    def __init__(self, validation_dir: str | Path, validation_default: str) -> None:
        self._validation_dir = Path(validation_dir)
        self._active: dict[str, str] = {"validation": validation_default}

    # ---- validation -------------------------------------------------------

    def _validation_files(self) -> dict[str, Path]:
        """Return ``{id (file stem): path}`` for config/validation/*.yaml."""
        if not self._validation_dir.is_dir():
            return {}
        return {p.stem: p for p in sorted(self._validation_dir.glob("*.yaml"))}

    def list_validation(self) -> list[ValidationOption]:
        """List loadable validation templates (skips any that fail to parse)."""
        options: list[ValidationOption] = []
        for stem, path in self._validation_files().items():
            try:
                tmpl = load_validation_template(path)
            except (ValueError, OSError) as exc:
                logger.warning(
                    "skipping invalid validation template",
                    extra={"path": str(path), "error": str(exc)},
                )
                continue
            options.append(
                ValidationOption(
                    id=stem,
                    name=tmpl.name,
                    version=tmpl.version,
                    required_topics=[t.model_dump() for t in tmpl.required_topics],
                )
            )
        return options

    def active_id(self, category: str = "validation") -> str:
        return self._active.get(category, "")

    def select(self, category: str, option_id: str) -> None:
        """Set the active option for *category*; 400/404 on bad input."""
        if category not in IMMEDIATE_CATEGORIES:
            raise ApiError(
                status_code=400,
                code="unknown_category",
                message=f"Unknown or non-selectable config category: {category}",
            )
        if option_id not in self._validation_files():
            raise ApiError(
                status_code=404,
                code="config_not_found",
                message=f"Validation template not found: {option_id}",
                details={"category": category, "id": option_id},
            )
        self._active[category] = option_id

    def validation_template_by_id(self, option_id: str) -> ValidationTemplate | None:
        """Load the validation template with id *option_id* (file stem).

        Returns ``None`` if no such template exists or it fails to parse. Used to
        resolve a UI-selected template *id* into the full object injected into a
        ``fast_validation`` job (the dora_runner template store is otherwise
        empty, so forwarding a bare id always 404s).
        """
        path = self._validation_files().get(option_id)
        if path is None:
            return None
        try:
            return load_validation_template(path)
        except (ValueError, OSError):
            return None

    def active_validation_template(self) -> ValidationTemplate | None:
        """Load the active validation template (falls back to any available)."""
        files = self._validation_files()
        if not files:
            return None
        stem = self._active.get("validation")
        path = files.get(stem) if stem else None
        if path is None:
            path = next(iter(files.values()))  # default missing -> first available
        try:
            return load_validation_template(path)
        except (ValueError, OSError):
            return None
