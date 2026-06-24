"""FastAPI dependencies shared by the run-lifecycle routers.

The :class:`~api_orchestrator.runs.RunService` is created at startup and stored
on ``app.state.run_service`` (see ``main.py``); routers resolve it through
:func:`get_run_service` so handlers stay thin and easy to test.
"""

from __future__ import annotations

from fastapi import Request

from api_orchestrator.runs import RunService


def get_run_service(request: Request) -> RunService:
    """Return the process-wide :class:`RunService` from ``app.state``."""
    return request.app.state.run_service
