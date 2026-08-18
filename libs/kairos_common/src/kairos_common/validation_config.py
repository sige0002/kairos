# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Loader and model for a validation template (VALIDATION_CONFIG).

A validation template declares which topics a recording must contain to be
considered valid for a robot/dataset/task. It is the input to ``dora_runner``'s
``fast_validation`` (it IS the dora ``ValidationTemplate`` shape: ``name`` /
``version`` / ``required_topics: [{name, type?}]``). Extracted from the
recording config so it can be selected independently in the Config tab. The
canonical files live under ``config/<robot>/validation/``.

Unknown keys are rejected (``extra="forbid"``) so typos surface.
"""

from __future__ import annotations

from pathlib import Path

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError


class _StrictModel(BaseModel):
    """Base model that forbids unknown keys (typo detection)."""

    model_config = ConfigDict(extra="forbid")


class RequiredTopic(_StrictModel):
    """A topic a recording must contain. ``name`` may be a glob; ``type`` optional."""

    name: str
    type: str | None = None


class ValidationTemplate(_StrictModel):
    """A validation template (the fast_validation contract)."""

    name: str
    version: int = 1
    required_topics: list[RequiredTopic] = Field(default_factory=list)


def load_validation_template(path: str | Path) -> ValidationTemplate:
    """Load and validate a :class:`ValidationTemplate` from a YAML/JSON file.

    Raises:
        FileNotFoundError: If *path* does not exist.
        ValueError: If the content is not a mapping or fails validation.
    """
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"Validation template not found: {path}")

    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        # See load_recording_config: a YAMLError is neither ValueError nor
        # OSError, so it bypasses every caller's degradation path.
        raise ValueError(
            f"Validation template is not valid YAML: {path}\n{exc}"
        ) from exc
    if not isinstance(raw, dict):
        raise ValueError(f"Validation template root must be a mapping: {path}")
    try:
        return ValidationTemplate.model_validate(raw)
    except ValidationError as exc:
        raise ValueError(f"Invalid validation template: {path}\n{exc}") from exc
