"""Shared FastAPI app factory for kairos services.

:func:`create_app` returns a FastAPI app that already has the cross-cutting
plumbing every service needs:

- ``GET /healthz`` (liveness) and ``GET /readyz`` (readiness)
- the unified error model installed as exception handlers
- CORS configured from ``CORS_ORIGINS``
- JSON-lines logging configured from ``LOG_LEVEL``

Services build on top of it by adding their own routes; per-service business
logic lives in each service package.
"""

from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from kairos_common.errors import ApiError, ErrorBody, ErrorModel
from kairos_common.logging import configure_logging
from kairos_common.settings import Settings, get_settings

logger = logging.getLogger("kairos")


def error_response(
    status_code: int,
    code: str,
    message: str,
    details: dict[str, object] | None = None,
) -> JSONResponse:
    """Build a :class:`JSONResponse` in the unified error shape."""
    body = ErrorModel(
        error=ErrorBody(code=code, message=message, details=dict(details or {}))
    )
    return JSONResponse(status_code=status_code, content=body.model_dump())


def _install_exception_handlers(app: FastAPI) -> None:
    """Render every error in the unified ``{error:{...}}`` shape.

    Covers ``ApiError``, Starlette ``HTTPException`` (404/405/...), request
    validation (422), and any uncaught exception (500, logged server-side).
    """

    @app.exception_handler(ApiError)
    async def _handle_api_error(_: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code, content=exc.to_model().model_dump()
        )

    @app.exception_handler(StarletteHTTPException)
    async def _handle_http_exception(
        _: Request, exc: StarletteHTTPException
    ) -> JSONResponse:
        return error_response(
            status_code=exc.status_code,
            code=f"http_{exc.status_code}",
            message=str(exc.detail),
        )

    @app.exception_handler(RequestValidationError)
    async def _handle_validation_error(
        _: Request, exc: RequestValidationError
    ) -> JSONResponse:
        return error_response(
            status_code=422,
            code="validation_error",
            message="Request validation failed.",
            details={"errors": jsonable_encoder(exc.errors())},
        )

    @app.exception_handler(Exception)
    async def _handle_unexpected(_: Request, exc: Exception) -> JSONResponse:
        # Log full context server-side; never leak internals to the client.
        logger.exception("Unhandled exception")
        return error_response(
            status_code=500,
            code="internal_error",
            message="An unexpected error occurred.",
        )


def create_app(title: str, settings: Settings | None = None) -> FastAPI:
    """Create a FastAPI app with kairos cross-cutting concerns wired in.

    Args:
        title: Human-readable service title (used in OpenAPI).
        settings: Optional pre-built :class:`Settings`; defaults to the
            process-wide cached instance.

    Returns:
        A configured :class:`FastAPI` app exposing ``/healthz`` and
        ``/readyz``. Services add their own routes afterwards.
    """
    settings = settings or get_settings()
    configure_logging(settings.log_level)

    app = FastAPI(title=title)
    app.state.settings = settings

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    _install_exception_handlers(app)

    @app.get("/healthz", tags=["health"])
    async def healthz() -> dict[str, str]:
        """Liveness probe: the process is up and serving."""
        return {"status": "ok"}

    @app.get("/readyz", tags=["health"])
    async def readyz() -> dict[str, str]:
        """Readiness probe.

        Stage 0 skeleton always reports ready; services override or extend
        this once they have real dependencies to check.
        """
        return {"status": "ready"}

    return app
