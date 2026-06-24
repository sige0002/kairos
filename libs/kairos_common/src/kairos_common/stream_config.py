"""Loader and validator for the Stream tab layout config (STREAM_CONFIG).

This is a small, UI-facing config (separate from the recording/monitoring
``RECORDING_CONFIG``): it decides how many WebRTC preview panes the frontend's
Stream tab opens by default and which camera topic each one shows. The
orchestrator loads it and surfaces it via ``GET /api/v1/config`` (``stream``);
the frontend initializes its panes from it. The canonical file is
``config/stream.yaml``.

Unknown keys are rejected (``extra="forbid"``) so typos surface instead of
silently doing nothing.
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError


class _StrictModel(BaseModel):
    """Base model that forbids unknown keys (typo detection)."""

    model_config = ConfigDict(extra="forbid")


class StreamPane(_StrictModel):
    """One initial preview pane: the camera (image) topic it shows.

    ``topic`` may be omitted (``None``) to open an empty pane the operator
    picks in the UI.
    """

    topic: str | None = None


class StreamConfig(_StrictModel):
    """Top-level Stream tab layout config (the STREAM_CONFIG YAML)."""

    # Preview-grid column count (UI hint); panes wrap to the next row.
    columns: Annotated[int, Field(ge=1, le=4)] = 2
    panes: list[StreamPane] = Field(default_factory=list)


def load_stream_config(path: str | Path) -> StreamConfig:
    """Load and validate a :class:`StreamConfig` from a YAML file.

    Args:
        path: Path to the ``STREAM_CONFIG`` YAML file.

    Returns:
        A validated :class:`StreamConfig`.

    Raises:
        FileNotFoundError: If *path* does not exist.
        ValueError: If the YAML is not a mapping or fails validation.
    """
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"Stream config not found: {path}")

    with path.open("r", encoding="utf-8") as fh:
        raw = yaml.safe_load(fh)

    if raw is None:
        return StreamConfig()
    if not isinstance(raw, dict):
        raise ValueError(f"Stream config root must be a mapping: {path}")

    try:
        return StreamConfig.model_validate(raw)
    except ValidationError as exc:
        raise ValueError(f"Invalid stream config: {path}\n{exc}") from exc
