# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Unified error model shared by all kairos HTTP services.

Every API returns errors in the single shape defined in ``config.md``::

    { "error": { "code": "...", "message": "...", "details": {} } }

:class:`ApiError` is the exception services raise; the handler installed by
:func:`kairos_common.app.create_app` renders it (and unexpected errors) into
this shape. :class:`ErrorModel` is the pydantic model so the shape shows up in
the generated OpenAPI schema.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class ErrorBody(BaseModel):
    """Inner body of the unified error model."""

    code: str = Field(description="Stable machine-readable error code.")
    message: str = Field(description="Human-readable error message.")
    details: dict[str, Any] = Field(
        default_factory=dict,
        description="Optional structured context for the error.",
    )


class ErrorModel(BaseModel):
    """Top-level error envelope: ``{ "error": { ... } }``."""

    error: ErrorBody


class ApiError(Exception):
    """Raise to return a unified error response with a specific status code.

    Args:
        status_code: HTTP status (e.g. 404, 409, 422, 503, 507).
        code: Stable machine-readable code (e.g. ``"not_found"``).
        message: Human-readable message.
        details: Optional structured context.
    """

    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.details = details or {}

    def to_model(self) -> ErrorModel:
        """Render this error into the serializable :class:`ErrorModel`."""
        return ErrorModel(
            error=ErrorBody(code=self.code, message=self.message, details=self.details)
        )
